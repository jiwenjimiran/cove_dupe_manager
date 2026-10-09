using System.Globalization;
using System.Numerics;
using Cove.Core.Entities;
using Cove.Data;
using Microsoft.EntityFrameworkCore;

namespace Cove.DuplicateManager;

public sealed record PhotoDuplicateSearchRequest(
    string MatchType = "fingerprint",
    string FingerprintAlgorithm = "any",
    int PhashDistance = 8,
    IReadOnlyList<string>? IncludePaths = null,
    IReadOnlyList<string>? ExcludePaths = null);

public sealed record PhotoDuplicateFile(int Id, int ImageId, string Path, int Width, int Height, long Size, bool InArchive);
public sealed record PhotoDuplicateItem(int Id, string? Title, PhotoDuplicateFile File, int FileCount);
public sealed record PhotoDuplicateGroup(int RecommendedKeeperId, int RecommendedKeeperFileId, IReadOnlyList<PhotoDuplicateItem> Images, IReadOnlyList<PhotoDuplicateFile> MatchedFiles);
public sealed record PhotoDuplicateSearchResult(IReadOnlyList<PhotoDuplicateGroup> Groups);

internal static class PhotoDuplicateSearch
{
    private sealed record Candidate(int FileId, int ImageId, string Value);
    private sealed record HashBucket(ulong Hash, Candidate[] Candidates);

    internal static async Task<PhotoDuplicateSearchResult> FindAsync(
        CoveContext db, PhotoDuplicateSearchRequest request, CancellationToken ct)
    {
        var matchType = request.MatchType?.Trim().ToLowerInvariant();
        if (matchType is not ("fingerprint" or "phash" or "title" or "filename"))
            throw new ArgumentException("Photo matching supports exact fingerprint, visual pHash, same title, and same filename.");

        var includes = Search.DuplicateSearchJobService.NormalizeScopePaths(request.IncludePaths);
        var excludes = Search.DuplicateSearchJobService.NormalizeScopePaths(request.ExcludePaths);
        bool InScope(string path) =>
            (includes.Length == 0 || includes.Any(folder => Search.DuplicateSearchJobService.IsAtOrBelow(path, folder)))
            && !excludes.Any(folder => Search.DuplicateSearchJobService.IsAtOrBelow(path, folder));

        var parent = new Dictionary<int, int>();
        var fileOwners = new Dictionary<int, int>();
        void Connect(int left, int right)
        {
            parent.TryAdd(left, left);
            parent.TryAdd(right, right);
            var low = Root(left);
            var high = Root(right);
            if (low != high) parent[Math.Max(low, high)] = Math.Min(low, high);
        }
        int Root(int id)
        {
            while (parent[id] != id)
            {
                parent[id] = parent[parent[id]];
                id = parent[id];
            }
            return id;
        }
        void MatchBucket(IEnumerable<Candidate> candidates)
        {
            var rows = candidates.ToArray();
            var ids = rows.Select(row => row.FileId).Distinct().ToArray();
            if (ids.Length < 2) return;
            for (var index = 1; index < ids.Length; index++) Connect(ids[0], ids[index]);
            foreach (var row in rows)
                fileOwners[row.FileId] = row.ImageId;
        }
        void MatchHashBuckets(HashBucket left, HashBucket right)
        {
            if (left.Candidates.Select(row => row.FileId).Concat(right.Candidates.Select(row => row.FileId)).Distinct().Skip(1).Any())
                MatchBucket(left.Candidates.Concat(right.Candidates));
        }

        if (matchType is "title" or "filename")
        {
            var rows = await db.ImageFiles.AsNoTracking().Where(file => file.ImageId.HasValue)
                .Join(db.Images.AsNoTracking(),
                    file => file.ImageId!.Value, image => image.Id,
                    (file, image) => new { FileId = file.Id, ImageId = image.Id, file.Path, file.Basename, image.Title })
                .ToListAsync(ct);
            foreach (var bucket in rows.Where(row => InScope(row.Path))
                .GroupBy(row => Search.DuplicateSearchExecutionService.NormalizeTitle(
                    matchType == "filename" || string.IsNullOrWhiteSpace(row.Title)
                        ? Path.GetFileNameWithoutExtension(row.Basename)
                        : row.Title), StringComparer.OrdinalIgnoreCase)
                .Where(bucket => bucket.Key.Length > 0))
                MatchBucket(bucket.Select(row => new Candidate(row.FileId, row.ImageId, bucket.Key)));
        }
        else
        {
            var algorithm = request.FingerprintAlgorithm?.Trim().ToLowerInvariant();
            var rows = await db.FileFingerprints.AsNoTracking()
                .Where(fingerprint => fingerprint.Value != "" && (matchType == "phash"
                    ? fingerprint.Type == "phash"
                    : algorithm == "md5" ? fingerprint.Type == "md5"
                    : algorithm == "oshash" ? fingerprint.Type == "oshash"
                    : fingerprint.Type == "md5" || fingerprint.Type == "oshash"))
                .Join(db.ImageFiles.AsNoTracking().Where(file => file.ImageId.HasValue),
                    fingerprint => fingerprint.FileId, file => file.Id,
                    (fingerprint, file) => new { FileId = file.Id, ImageId = file.ImageId!.Value, file.Path, fingerprint.Type, fingerprint.Value })
                .ToListAsync(ct);
            var candidates = rows.Where(row => InScope(row.Path))
                .Select(row => new Candidate(row.FileId, row.ImageId, row.Type + ":" + row.Value)).ToArray();
            if (matchType == "fingerprint")
            {
                foreach (var bucket in candidates.GroupBy(row => row.Value)) MatchBucket(bucket);
            }
            else
            {
                var hashes = candidates.Select(row =>
                {
                    var value = row.Value[6..].Trim(); // Remove "phash:".
                    if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) value = value[2..];
                    ulong hash = 0;
                    return (row, valid: value.Length is > 0 and <= 16
                        && ulong.TryParse(value, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out hash), hash);
                }).Where(item => item.valid)
                  .GroupBy(item => item.hash)
                  .Select(bucket => new HashBucket(bucket.Key, bucket.Select(item => item.row).ToArray()))
                  .ToArray();
                foreach (var bucket in hashes) MatchBucket(bucket.Candidates);
                var distance = Math.Clamp(request.PhashDistance, 0, 64);
                if (distance == 64)
                    MatchBucket(hashes.SelectMany(bucket => bucket.Candidates));
                else if (distance > 0)
                {
                    var segments = distance + 1;
                    var index = new Dictionary<(int Segment, ulong Value), List<int>>();
                    for (var position = 0; position < hashes.Length; position++)
                    {
                        ct.ThrowIfCancellationRequested();
                        var seen = new HashSet<int>();
                        var offset = 0;
                        for (var segment = 0; segment < segments; segment++)
                        {
                            var width = 64 / segments + (segment < 64 % segments ? 1 : 0);
                            var mask = width == 64 ? ulong.MaxValue : width == 0 ? 0UL : (1UL << width) - 1;
                            var key = (segment, (hashes[position].Hash >> offset) & mask);
                            if (!index.TryGetValue(key, out var bucket)) index[key] = bucket = [];
                            foreach (var other in bucket)
                            {
                                if (seen.Add(other) && BitOperations.PopCount(hashes[position].Hash ^ hashes[other].Hash) <= distance)
                                    MatchHashBuckets(hashes[position], hashes[other]);
                            }
                            bucket.Add(position);
                            offset += width;
                        }
                    }
                }
            }
        }

        foreach (var imageFiles in fileOwners.GroupBy(pair => pair.Value))
        {
            var ids = imageFiles.Select(pair => pair.Key).ToArray();
            for (var index = 1; index < ids.Length; index++) Connect(ids[0], ids[index]);
        }
        var components = parent.Keys.GroupBy(Root).Select(group => group.Order().ToArray())
            .Where(group => group.Length > 1).ToArray();
        var matchedFileIds = components.SelectMany(group => group).Distinct().ToArray();
        var files = new Dictionary<int, ImageFile>();
        foreach (var chunk in matchedFileIds.Chunk(4000))
            foreach (var file in await db.ImageFiles.AsNoTracking().Where(file => chunk.Contains(file.Id))
                .Include(file => file.Image).ToListAsync(ct))
                if (file.Image is not null && file.ImageId.HasValue) files[file.Id] = file;
        var imageIds = files.Values.Where(file => file.ImageId.HasValue).Select(file => file.ImageId!.Value).Distinct().ToArray();
        var fileCounts = new Dictionary<int, int>();
        foreach (var chunk in imageIds.Chunk(4000))
            foreach (var count in await db.ImageFiles.AsNoTracking().Where(file => file.ImageId.HasValue && chunk.Contains(file.ImageId.Value))
                .GroupBy(file => file.ImageId!.Value).Select(group => new { ImageId = group.Key, Count = group.Count() }).ToListAsync(ct))
                fileCounts[count.ImageId] = count.Count;

        var groups = new List<PhotoDuplicateGroup>(components.Length);
        foreach (var component in components)
        {
            var items = component.Where(files.ContainsKey).Select(id =>
            {
                var file = files[id];
                var imageId = file.ImageId!.Value;
                return new PhotoDuplicateItem(imageId, file.Image?.Title,
                    new PhotoDuplicateFile(file.Id, imageId, file.Path, file.Width, file.Height, file.Size,
                        file.ZipFileId.HasValue || DuplicateManagerExtension.IsArchivePath(file.Path)), fileCounts[imageId]);
            }).OrderByDescending(item => (long)item.File.Width * item.File.Height)
              .ThenBy(item => item.File.Size).ThenBy(item => item.File.Id).ToArray();
            if (items.Length < 2) continue;
            var matched = items.Select(item => item.File).OrderBy(file => file.Id).ToArray();
            groups.Add(new PhotoDuplicateGroup(items[0].Id, items[0].File.Id, items, matched));
        }
        return new PhotoDuplicateSearchResult(groups.OrderBy(group => group.Images[0].File.Id).ToArray());
    }
}

using System.Text.Json;
using Cove.Core.Entities;
using Cove.Data;
using Cove.Plugins;
using Cove.Sdk;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Cove.DuplicateManager;

public sealed partial class DuplicateManagerExtension
{
    private const string ActionsKey = "prepared-file-actions-v2";
    private const string TrashKey = "trash-v2";

    public sealed record PreparedFile(int Id, string Path, long Size, bool InArchive);
    public sealed record PreparedAction(string Token, string MediaType, int EntityId, string Mode,
        DateTime CreatedAt, List<PreparedFile> Files);
    public sealed record TrashEntry(string Path, string OriginalPath, long Size, int FileId,
        string MediaType, int EntityId, DateTime CreatedAt);
    public sealed record PrepareRequest(string MediaType, int EntityId, string Mode, List<int>? FileIds = null);
    public sealed record TokenRequest(string Token);
    public sealed record EngagementMergeRequest(int TargetId, List<int> SourceIds);
    public sealed record ImageMergeRequest(int TargetImageId, List<int> SourceImageIds);

    private void MapMergeEndpoints(IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/ext/duplicate-manager");
        group.MapPost("/videos/engagement-merge", MergeVideoEngagementAsync)
            .RequireCovePermission("videos.write");
        group.MapPost("/files/prepare", PrepareFilesAsync)
            .RequireCovePermission("videos.delete");
        group.MapPost("/files/finalize", FinalizeFilesAsync)
            .RequireCovePermission("videos.delete");
        group.MapGet("/trash", ListTrashAsync).RequireCovePermission("videos.read");
        group.MapPost("/trash/restore", RestoreTrashAsync).RequireCovePermission("videos.delete");
        group.MapPost("/trash/empty", EmptyTrashAsync).RequireCovePermission("videos.delete");

        group.MapGet("/images/duplicates", FindDuplicateImagesAsync)
            .RequireCovePermission("images.read");
        group.MapPost("/images/merge", MergeImagesAsync)
            .RequireCovePermission("images.write");
        group.MapPost("/images/prune", PruneImagesAsync)
            .RequireCovePermission("images.delete");
        group.MapPost("/images/files/finalize", FinalizeFilesAsync)
            .RequireCovePermission("images.delete");
    }

    private async Task<List<T>> ReadStateAsync<T>(string key, CancellationToken ct)
    {
        if (_store is null) return [];
        var json = await _store.GetAsync(key, ct);
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<List<T>>(json) ?? []; }
        catch { return []; }
    }

    private async Task WriteStateAsync<T>(string key, List<T> value, CancellationToken ct)
    {
        if (_store is not null) await _store.SetAsync(key, JsonSerializer.Serialize(value), ct);
    }

    private static bool IsArchivePath(string? path) => !string.IsNullOrWhiteSpace(path)
        && (path.Replace('\\', '/').Contains(".zip/", StringComparison.OrdinalIgnoreCase)
            || path.Replace('\\', '/').Contains(".cbz/", StringComparison.OrdinalIgnoreCase));

    private async Task<IResult> PrepareFilesAsync(PrepareRequest request, HttpContext http, CancellationToken ct)
    {
        var media = request.MediaType?.Trim().ToLowerInvariant();
        var mode = request.Mode?.Trim().ToLowerInvariant();
        if (media is not ("video" or "image") || mode is not ("trash" or "permanent"))
            return Results.BadRequest(new { message = "mediaType and mode are invalid" });

        var db = http.RequestServices.GetRequiredService<CoveContext>();
        var wanted = request.FileIds?.ToHashSet();
        List<PreparedFile> files;
        if (media == "video")
        {
            files = await db.VideoFiles.AsNoTracking().Where(f => f.VideoId == request.EntityId)
                .Where(f => wanted == null || wanted.Contains(f.Id))
                .Select(f => new PreparedFile(f.Id, f.Path!, f.Size, false)).ToListAsync(ct);
        }
        else
        {
            files = await db.ImageFiles.AsNoTracking().Where(f => f.ImageId == request.EntityId)
                .Where(f => wanted == null || wanted.Contains(f.Id))
                .Select(f => new PreparedFile(f.Id, f.Path!, f.Size, f.ZipFileId != null)).ToListAsync(ct);
            files = files.Select(f => f with { InArchive = f.InArchive || IsArchivePath(f.Path) }).ToList();
        }
        files = files.Where(f => !string.IsNullOrWhiteSpace(f.Path)).ToList();
        if (files.Count == 0) return Results.BadRequest(new { message = "no eligible files found" });
        if (files.Any(f => f.InArchive)) return Results.BadRequest(new { message = "archive entries cannot be removed" });

        var actions = await ReadStateAsync<PreparedAction>(ActionsKey, ct);
        var action = new PreparedAction(Guid.NewGuid().ToString("N"), media, request.EntityId, mode,
            DateTime.UtcNow, files);
        actions.RemoveAll(a => a.CreatedAt < DateTime.UtcNow.AddDays(-7));
        actions.Add(action);
        await WriteStateAsync(ActionsKey, actions, ct);
        return Results.Ok(new { action.Token, fileCount = files.Count, bytes = files.Sum(f => f.Size) });
    }

    private async Task<IResult> FinalizeFilesAsync(TokenRequest request, CancellationToken ct)
    {
        var actions = await ReadStateAsync<PreparedAction>(ActionsKey, ct);
        var action = actions.SingleOrDefault(a => a.Token == request.Token);
        if (action is null) return Results.NotFound(new { message = "prepared action not found" });

        var trash = await ReadStateAsync<TrashEntry>(TrashKey, ct);
        var completed = new List<object>();
        foreach (var file in action.Files)
        {
            if (!File.Exists(file.Path)) { completed.Add(new { file.Id, file.Path, missing = true }); continue; }
            if (action.Mode == "permanent")
            {
                File.Delete(file.Path);
                completed.Add(new { file.Id, file.Path, deleted = true });
                continue;
            }
            var sourceDir = Path.GetDirectoryName(Path.GetFullPath(file.Path))!;
            var trashDir = Path.Combine(sourceDir, ".dedup-trash", DateTime.UtcNow.ToString("yyyy-MM-dd"));
            Directory.CreateDirectory(trashDir);
            var destination = Path.GetFullPath(Path.Combine(trashDir, $"{file.Id}_{Path.GetFileName(file.Path)}"));
            if (!destination.StartsWith(Path.GetFullPath(Path.Combine(sourceDir, ".dedup-trash")) + Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { message = "invalid trash destination" });
            File.Move(file.Path, destination, false);
            trash.Add(new TrashEntry(destination, file.Path, file.Size, file.Id,
                action.MediaType, action.EntityId, DateTime.UtcNow));
            completed.Add(new { file.Id, originalPath = file.Path, path = destination });
        }
        actions.Remove(action);
        await WriteStateAsync(TrashKey, trash, ct);
        await WriteStateAsync(ActionsKey, actions, ct);
        return Results.Ok(new { completed, remainingPrepared = actions.Count });
    }

    private async Task<IResult> ListTrashAsync(CancellationToken ct)
    {
        var entries = await ReadStateAsync<TrashEntry>(TrashKey, ct);
        var live = entries.Where(e => File.Exists(e.Path) && IsValidTrashEntry(e)).ToList();
        return Results.Ok(new { count = live.Count, bytes = live.Sum(e => e.Size), entries = live.Take(500) });
    }

    private static bool IsValidTrashEntry(TrashEntry entry)
    {
        var originalDir = Path.GetDirectoryName(Path.GetFullPath(entry.OriginalPath));
        if (originalDir is null) return false;
        var root = Path.GetFullPath(Path.Combine(originalDir, ".dedup-trash")) + Path.DirectorySeparatorChar;
        var candidate = Path.GetFullPath(entry.Path);
        return candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            && Path.GetFileName(candidate).StartsWith($"{entry.FileId}_", StringComparison.Ordinal);
    }

    private async Task<IResult> RestoreTrashAsync(TokenRequest request, CancellationToken ct)
    {
        var entries = await ReadStateAsync<TrashEntry>(TrashKey, ct);
        var entry = entries.SingleOrDefault(e => e.Path == request.Token);
        if (entry is null || !IsValidTrashEntry(entry)) return Results.BadRequest(new { message = "invalid trash entry" });
        if (!File.Exists(entry.Path)) return Results.NotFound(new { message = "trash file is missing" });
        if (File.Exists(entry.OriginalPath)) return Results.Conflict(new { message = "original path already exists" });
        Directory.CreateDirectory(Path.GetDirectoryName(entry.OriginalPath)!);
        File.Move(entry.Path, entry.OriginalPath, false);
        entries.Remove(entry);
        await WriteStateAsync(TrashKey, entries, ct);
        return Results.Ok(new { restored = entry.OriginalPath });
    }

    private async Task<IResult> EmptyTrashAsync(CancellationToken ct)
    {
        var entries = await ReadStateAsync<TrashEntry>(TrashKey, ct);
        var failed = new List<object>(); long freed = 0; int deleted = 0;
        foreach (var entry in entries.ToList())
        {
            if (!IsValidTrashEntry(entry)) { failed.Add(new { entry.Path, error = "validation failed" }); continue; }
            try { if (File.Exists(entry.Path)) File.Delete(entry.Path); freed += entry.Size; deleted++; entries.Remove(entry); }
            catch (Exception ex) { failed.Add(new { entry.Path, error = ex.Message }); }
        }
        await WriteStateAsync(TrashKey, entries, ct);
        return Results.Ok(new { deleted, freed, remaining = entries.Count, failed });
    }

    private static async Task<IResult> MergeVideoEngagementAsync(EngagementMergeRequest request, HttpContext http, CancellationToken ct)
    {
        if (request.SourceIds.Count == 0 || request.SourceIds.Contains(request.TargetId))
            return Results.BadRequest(new { message = "invalid sourceIds" });
        var db = http.RequestServices.GetRequiredService<CoveContext>();
        var strategy = db.Database.CreateExecutionStrategy();
        var moved = await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear(); await using var tx = await db.Database.BeginTransactionAsync(ct);
            var targets = await db.UserEntityAffinities.Where(a => a.HostType == AffinityHostType.Video && a.HostId == request.TargetId)
                .ToDictionaryAsync(a => a.UserId, ct);
            int count = 0;
            foreach (var source in await db.UserEntityAffinities.Where(a => a.HostType == AffinityHostType.Video && request.SourceIds.Contains(a.HostId)).ToListAsync(ct))
            {
                if (targets.TryGetValue(source.UserId, out var target))
                {
                    target.LikeCount += source.LikeCount; target.DerivedLikeCount += source.DerivedLikeCount;
                    target.ViewCount += source.ViewCount; target.CompleteCount += source.CompleteCount;
                    target.TotalConsumedSec += source.TotalConsumedSec; target.InteractionCount += source.InteractionCount;
                    target.PageVisitCount += source.PageVisitCount; target.OpenDetailCount += source.OpenDetailCount;
                    target.IsFavorite |= source.IsFavorite; target.IsBookmarked |= source.IsBookmarked;
                    target.FavoritedAt = Earlier(target.FavoritedAt, source.FavoritedAt);
                    target.LastConsumedAt = Later(target.LastConsumedAt, source.LastConsumedAt);
                    target.LastInteractedAt = Later(target.LastInteractedAt, source.LastInteractedAt);
                    target.UpdatedAt = DateTime.UtcNow;
                    db.UserEntityAffinities.Remove(source);
                }
                else { source.HostId = request.TargetId; source.UpdatedAt = DateTime.UtcNow; targets[source.UserId] = source; }
                count++;
            }
            var haveRatings = (await db.Ratings
                .Where(r => r.HostType == RatingHostType.Video && r.HostId == request.TargetId)
                .Select(r => new { r.UserId, r.Aspect }).ToListAsync(ct))
                .Select(r => (r.UserId, r.Aspect)).ToHashSet();
            int ratings = 0;
            foreach (var rating in await db.Ratings
                .Where(r => r.HostType == RatingHostType.Video && request.SourceIds.Contains(r.HostId)).ToListAsync(ct))
            {
                if (haveRatings.Add((rating.UserId, rating.Aspect)))
                { rating.HostId = request.TargetId; rating.UpdatedAt = DateTime.UtcNow; ratings++; }
                else db.Ratings.Remove(rating);
            }
            var bookmarks = await db.UserBookmarks.Where(b => b.HostType == AffinityHostType.Video && request.SourceIds.Contains(b.HostId)).ToListAsync(ct);
            var haveBookmarks = (await db.UserBookmarks.Where(b => b.HostType == AffinityHostType.Video && b.HostId == request.TargetId).Select(b => b.UserId).ToListAsync(ct)).ToHashSet();
            foreach (var bookmark in bookmarks) { if (haveBookmarks.Add(bookmark.UserId)) bookmark.HostId = request.TargetId; else db.UserBookmarks.Remove(bookmark); }
            await db.SaveChangesAsync(ct);
            var interactions = await db.Interactions.Where(i => i.HostType == InteractionHostType.Video && request.SourceIds.Contains(i.HostId))
                .ExecuteUpdateAsync(s => s.SetProperty(i => i.HostId, request.TargetId), ct);
            await tx.CommitAsync(ct); return new { affinities = count, ratings, bookmarks = bookmarks.Count, interactions };
        });
        return Results.Ok(moved);
    }

    private static DateTime? Earlier(DateTime? a, DateTime? b) => a is null ? b : b is null ? a : a < b ? a : b;
    private static DateTime? Later(DateTime? a, DateTime? b) => a is null ? b : b is null ? a : a > b ? a : b;

    private static async Task<IResult> FindDuplicateImagesAsync(HttpContext http, CancellationToken ct,
        int page = 1, int pageSize = 25, long minBytes = 0)
    {
        var db = http.RequestServices.GetRequiredService<CoveContext>();
        page = Math.Max(1, page); pageSize = Math.Clamp(pageSize, 1, 100);
        var hashes = await db.FileFingerprints.AsNoTracking().Where(f => f.Type == "phash")
            .Join(db.ImageFiles.AsNoTracking(), f => f.FileId, i => i.Id, (f, i) => new { f.Value, File = i })
            .Where(x => x.File.ImageId != null)
            .GroupBy(x => x.Value).Where(g => g.Count() > 1)
            .Select(g => new { Hash = g.Key, Bytes = g.Sum(x => x.File.Size) - g.Max(x => x.File.Size), Count = g.Count() })
            .Where(g => g.Bytes >= minBytes).OrderByDescending(g => g.Bytes).ToListAsync(ct);
        var selected = hashes.Skip((page - 1) * pageSize).Take(pageSize).Select(h => h.Hash).ToList();
        var rows = await db.FileFingerprints.AsNoTracking().Where(f => f.Type == "phash" && selected.Contains(f.Value))
            .Join(db.ImageFiles.AsNoTracking(), f => f.FileId, i => i.Id, (f, i) => new { f.Value, i.Id, i.ImageId, i.Width, i.Height, i.Size, i.Path, i.ZipFileId }).ToListAsync(ct);
        var groups = rows.GroupBy(r => r.Value).Select(g =>
        {
            var files = g.Where(x => x.ImageId != null).OrderByDescending(x => (long)x.Width * x.Height).ThenByDescending(x => x.Size).ToList();
            var keeper = files.First();
            return new { hash = g.Key, keeperFileId = keeper.Id, imageIds = files.Select(x => x.ImageId).Distinct(),
                freeableBytes = files.Where(x => x.Id != keeper.Id && x.ZipFileId == null && !IsArchivePath(x.Path)).Sum(x => x.Size),
                files = files.Select(x => new { x.Id, x.ImageId, x.Width, x.Height, x.Size, x.Path, inArchive = x.ZipFileId != null || IsArchivePath(x.Path) }) };
        }).ToList();
        return Results.Ok(new { page, pageSize, total = hashes.Count, groups });
    }

    private static async Task<IResult> MergeImagesAsync(ImageMergeRequest request, HttpContext http, CancellationToken ct)
    {
        if (request.SourceImageIds.Count == 0 || request.SourceImageIds.Contains(request.TargetImageId))
            return Results.BadRequest(new { message = "invalid sourceImageIds" });
        var db = http.RequestServices.GetRequiredService<CoveContext>();
        var sourceIds = request.SourceImageIds;
        var strategy = db.Database.CreateExecutionStrategy();
        var result = await strategy.ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear(); await using var tx = await db.Database.BeginTransactionAsync(ct);
            int tags = 0, performers = 0, galleries = 0, urls = 0, files = 0, affinities = 0, ratings = 0;
            var haveTags = (await db.Set<ImageTag>().Where(x => x.ImageId == request.TargetImageId).Select(x => x.TagId).ToListAsync(ct)).ToHashSet();
            foreach (var row in await db.Set<ImageTag>().Where(x => sourceIds.Contains(x.ImageId)).ToListAsync(ct))
            { if (haveTags.Add(row.TagId)) { db.Set<ImageTag>().Add(new ImageTag { ImageId = request.TargetImageId, TagId = row.TagId }); tags++; } db.Remove(row); }
            var havePerformers = (await db.Set<ImagePerformer>().Where(x => x.ImageId == request.TargetImageId).Select(x => x.PerformerId).ToListAsync(ct)).ToHashSet();
            foreach (var row in await db.Set<ImagePerformer>().Where(x => sourceIds.Contains(x.ImageId)).ToListAsync(ct))
            { if (havePerformers.Add(row.PerformerId)) { db.Set<ImagePerformer>().Add(new ImagePerformer { ImageId = request.TargetImageId, PerformerId = row.PerformerId }); performers++; } db.Remove(row); }
            var haveGalleries = (await db.Set<ImageGallery>().Where(x => x.ImageId == request.TargetImageId).Select(x => x.GalleryId).ToListAsync(ct)).ToHashSet();
            foreach (var row in await db.Set<ImageGallery>().Where(x => sourceIds.Contains(x.ImageId)).ToListAsync(ct))
            { if (haveGalleries.Add(row.GalleryId)) { db.Set<ImageGallery>().Add(new ImageGallery { ImageId = request.TargetImageId, GalleryId = row.GalleryId }); galleries++; } db.Remove(row); }
            var haveUrls = (await db.Images.Where(x => x.Id == request.TargetImageId).SelectMany(x => x.Urls).Select(x => x.Url).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            foreach (var row in await db.Images.Where(x => sourceIds.Contains(x.Id)).SelectMany(x => x.Urls).ToListAsync(ct))
                if (haveUrls.Add(row.Url)) { row.ImageId = request.TargetImageId; urls++; }
            var targetAffinities = await db.UserEntityAffinities
                .Where(a => a.HostType == AffinityHostType.Image && a.HostId == request.TargetImageId)
                .ToDictionaryAsync(a => a.UserId, ct);
            foreach (var source in await db.UserEntityAffinities
                .Where(a => a.HostType == AffinityHostType.Image && sourceIds.Contains(a.HostId)).ToListAsync(ct))
            {
                if (targetAffinities.TryGetValue(source.UserId, out var target))
                {
                    target.LikeCount += source.LikeCount; target.DerivedLikeCount += source.DerivedLikeCount;
                    target.ViewCount += source.ViewCount; target.CompleteCount += source.CompleteCount;
                    target.TotalConsumedSec += source.TotalConsumedSec; target.InteractionCount += source.InteractionCount;
                    target.PageVisitCount += source.PageVisitCount; target.OpenDetailCount += source.OpenDetailCount;
                    target.IsFavorite |= source.IsFavorite; target.IsBookmarked |= source.IsBookmarked;
                    target.FavoritedAt = Earlier(target.FavoritedAt, source.FavoritedAt);
                    target.LastConsumedAt = Later(target.LastConsumedAt, source.LastConsumedAt);
                    target.LastInteractedAt = Later(target.LastInteractedAt, source.LastInteractedAt);
                    target.UpdatedAt = DateTime.UtcNow;
                    db.UserEntityAffinities.Remove(source);
                }
                else { source.HostId = request.TargetImageId; source.UpdatedAt = DateTime.UtcNow; targetAffinities[source.UserId] = source; }
                affinities++;
            }
            var haveRatings = (await db.Ratings
                .Where(r => r.HostType == RatingHostType.Image && r.HostId == request.TargetImageId)
                .Select(r => new { r.UserId, r.Aspect }).ToListAsync(ct))
                .Select(r => (r.UserId, r.Aspect)).ToHashSet();
            foreach (var rating in await db.Ratings
                .Where(r => r.HostType == RatingHostType.Image && sourceIds.Contains(r.HostId)).ToListAsync(ct))
            {
                if (haveRatings.Add((rating.UserId, rating.Aspect)))
                { rating.HostId = request.TargetImageId; rating.UpdatedAt = DateTime.UtcNow; ratings++; }
                else db.Ratings.Remove(rating);
            }
            var haveBookmarks = (await db.UserBookmarks
                .Where(b => b.HostType == AffinityHostType.Image && b.HostId == request.TargetImageId)
                .Select(b => b.UserId).ToListAsync(ct)).ToHashSet();
            foreach (var bookmark in await db.UserBookmarks
                .Where(b => b.HostType == AffinityHostType.Image && sourceIds.Contains(b.HostId)).ToListAsync(ct))
            { if (haveBookmarks.Add(bookmark.UserId)) bookmark.HostId = request.TargetImageId; else db.UserBookmarks.Remove(bookmark); }
            foreach (var file in await db.ImageFiles.Where(x => x.ImageId != null && sourceIds.Contains(x.ImageId.Value)).ToListAsync(ct))
            { file.ImageId = request.TargetImageId; files++; }
            await db.SaveChangesAsync(ct); await tx.CommitAsync(ct);
            return new { tags, performers, galleries, urls, files, affinities, ratings };
        });
        return Results.Ok(result);
    }

    private async Task<IResult> PruneImagesAsync(PrepareRequest request, HttpContext http, CancellationToken ct)
    {
        if (request.MediaType != "image" || request.FileIds is null || request.FileIds.Count == 0)
            return Results.BadRequest(new { message = "image fileIds are required" });
        var db = http.RequestServices.GetRequiredService<CoveContext>();
        var all = await db.ImageFiles.Where(f => f.ImageId == request.EntityId).ToListAsync(ct);
        var dropIds = request.FileIds.ToHashSet();
        var drop = all.Where(f => dropIds.Contains(f.Id)).ToList();
        if (drop.Count == 0 || drop.Count == all.Count)
            return Results.BadRequest(new { message = "refusing to remove zero or every image file" });
        if (drop.Any(f => f.ZipFileId != null || IsArchivePath(f.Path)))
            return Results.BadRequest(new { message = "archive entries cannot be removed" });
        var prepared = await PrepareFilesAsync(request, http, ct);
        if (prepared is not IStatusCodeHttpResult { StatusCode: >= 200 and < 300 }) return prepared;
        db.ImageFiles.RemoveRange(drop);
        await db.SaveChangesAsync(ct);
        return prepared;
    }
}

using System.Globalization;
using System.Numerics;
using System.Text.Json;
using Cove.Core.Entities;
using Cove.Data;
using Microsoft.EntityFrameworkCore;

namespace Cove.DuplicateManager;

internal static class VideoSegmentTransfer
{
    private const double MaximumDurationDifferenceSeconds = 1;

    // Cove's remove-files merge carries user markers only when the primary files have
    // equivalent timelines. Generated segments are never carried by that merge.
    internal static async Task<int> CopyForCleanupAsync(
        CoveContext db, IReadOnlyCollection<VideoDeletionJobItem> items,
        IReadOnlyDictionary<int, Video> videos, CancellationToken ct)
    {
        var ids = items.SelectMany(item => new[] { item.TargetId, item.SourceId }).Distinct().ToArray();
        var files = new List<VideoFile>();
        foreach (var chunk in ids.Chunk(2000))
            files.AddRange(await db.VideoFiles.AsNoTracking()
                .Where(file => file.VideoId.HasValue && chunk.Contains(file.VideoId.Value))
                .ToListAsync(ct));
        var filesByVideo = files.OrderBy(file => file.Id)
            .GroupBy(file => file.VideoId!.Value)
            .ToDictionary(group => group.Key, group => group.ToArray());
        VideoFile? PrimaryOf(int id) => filesByVideo.TryGetValue(id, out var available)
            ? available.FirstOrDefault(file => file.Id == videos[id].PrimaryFileId) ?? available[0]
            : null;

        var eligible = items.Select(item => (item, target: PrimaryOf(item.TargetId), source: PrimaryOf(item.SourceId)))
            .Where(pair => pair.target is { Duration: > 0 } && pair.source is { Duration: > 0 }
                && Math.Abs(pair.target.Duration - pair.source.Duration) <= MaximumDurationDifferenceSeconds)
            .ToArray();
        if (eligible.Length == 0) return 0;

        var primaryIds = eligible.SelectMany(pair => new[] { pair.target!.Id, pair.source!.Id }).Distinct().ToArray();
        var hashes = new Dictionary<int, string>();
        foreach (var chunk in primaryIds.Chunk(2000))
        {
            foreach (var row in await db.FileFingerprints.AsNoTracking()
                .Where(fingerprint => chunk.Contains(fingerprint.FileId)
                    && fingerprint.Type == "phash" && fingerprint.Value != "")
                .GroupBy(fingerprint => fingerprint.FileId)
                .Select(group => new { FileId = group.Key, Value = group.Min(fingerprint => fingerprint.Value) })
                .ToListAsync(ct))
                if (row.Value is not null) hashes[row.FileId] = row.Value;
        }

        var eligibleIds = eligible.SelectMany(pair => new[] { pair.item.TargetId, pair.item.SourceId }).Distinct().ToArray();
        var segments = new List<Segment>();
        foreach (var chunk in eligibleIds.Chunk(2000))
            segments.AddRange(await db.Segments.AsNoTracking()
                .Where(segment => segment.HostType == SegmentHostType.Video && chunk.Contains(segment.HostId))
                .ToListAsync(ct));
        var byVideo = segments.GroupBy(segment => segment.HostId)
            .ToDictionary(group => group.Key, group => group.ToArray());
        var signatures = new Dictionary<int, HashSet<string>>();
        var copied = 0;
        foreach (var pair in eligible)
        {
            var targetId = pair.item.TargetId;
            if (!signatures.TryGetValue(targetId, out var existing))
            {
                existing = (byVideo.GetValueOrDefault(targetId) ?? []).Select(Signature)
                    .ToHashSet(StringComparer.Ordinal);
                signatures[targetId] = existing;
            }
            var coreWillMoveUserMarkers = TimelinesEquivalent(
                hashes.GetValueOrDefault(pair.target!.Id), hashes.GetValueOrDefault(pair.source!.Id));
            foreach (var segment in byVideo.GetValueOrDefault(pair.item.SourceId) ?? [])
            {
                if (segment.SourceKey == "user" && coreWillMoveUserMarkers) continue;
                if (!existing.Add(Signature(segment))) continue;
                db.Segments.Add(new Segment
                {
                    HostType = SegmentHostType.Video, HostId = targetId,
                    StartSec = segment.StartSec, EndSec = segment.EndSec,
                    TagId = segment.TagId, Kind = segment.Kind, RefId = segment.RefId,
                    Payload = segment.Payload is null ? null : JsonDocument.Parse(segment.Payload.RootElement.GetRawText()),
                    SourceKey = segment.SourceKey, SourceRunId = segment.SourceRunId,
                    Confidence = segment.Confidence, Title = segment.Title,
                    ColorHint = segment.ColorHint, ImageBlobId = segment.ImageBlobId,
                });
                copied++;
            }
        }
        return copied;
    }

    private static bool TimelinesEquivalent(string? targetHash, string? sourceHash)
    {
        if (string.IsNullOrWhiteSpace(targetHash) || string.IsNullOrWhiteSpace(sourceHash)) return true;
        return ulong.TryParse(targetHash, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var target)
            && ulong.TryParse(sourceHash, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var source)
            && BitOperations.PopCount(target ^ source) <= 8;
    }

    private static string Signature(Segment segment) => JsonSerializer.Serialize(new
    {
        segment.StartSec, segment.EndSec, segment.TagId, segment.Kind, segment.RefId,
        Payload = segment.Payload?.RootElement.GetRawText(), segment.SourceKey,
        segment.SourceRunId, segment.Confidence, segment.Title, segment.ColorHint,
        segment.ImageBlobId,
    });
}

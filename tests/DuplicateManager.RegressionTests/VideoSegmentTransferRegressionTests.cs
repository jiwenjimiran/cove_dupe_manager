using System.Text.Json;
using Cove.Core.Entities;
using Cove.Data;
using Cove.DuplicateManager;
using Microsoft.EntityFrameworkCore;

internal static class VideoSegmentTransferRegressionTests
{
    internal static async Task RunAsync()
    {
        await using var db = new CoveContext(new DbContextOptionsBuilder<CoveContext>()
            .UseSqlite("Data Source=:memory:").Options);
        await db.Database.OpenConnectionAsync();
        await db.Database.EnsureCreatedAsync();
        db.Folders.Add(new Folder { Id = 1, Path = "/videos" });
        var videos = Enumerable.Range(1, 4)
            .Select(id => new Video { Id = id, Title = $"Video {id}" })
            .ToDictionary(video => video.Id);
        db.Videos.AddRange(videos.Values);
        await db.SaveChangesAsync();
        db.VideoFiles.AddRange(new[] { (1, 100.0), (2, 101.0), (3, 102.01), (4, 100.5) }
            .Select(row => new VideoFile { Id = row.Item1, VideoId = row.Item1,
                ParentFolderId = 1, Basename = $"{row.Item1}.mp4", Duration = row.Item2 }));
        await db.SaveChangesAsync();
        foreach (var video in videos.Values) video.PrimaryFileId = video.Id;
        db.FileFingerprints.AddRange(new[] { (1, "0000000000000000"), (2, "0000000000000000"), (4, "ffffffffffffffff") }
            .Select(row => new FileFingerprint { FileId = row.Item1, Type = "phash", Value = row.Item2 }));
        db.Segments.AddRange(
            Marker(1, 1, "ext:ai.tagging"), // Already on the keeper.
            Marker(2, 1, "ext:ai.tagging"), // Must not be copied twice.
            Marker(2, 2, "ext:ai.tagging"),
            Marker(2, 3, "user"), // Cove will transfer this equivalent user marker.
            Marker(3, 4, "ext:ai.tagging"), // More than one second away.
            Marker(4, 5, "ext:ai.tagging"),
            Marker(4, 6, "user")); // Same length, but hashes disagree: Cove would drop this.
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var items = new[] { new VideoDeletionJobItem(1, 2), new VideoDeletionJobItem(1, 3), new VideoDeletionJobItem(1, 4) };
        var copied = await VideoSegmentTransfer.CopyForCleanupAsync(db, items, videos, CancellationToken.None);
        Check(copied == 3, "Wrong number of segments copied.");
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        var keeper = await db.Segments.AsNoTracking().Where(segment => segment.HostId == 1).OrderBy(segment => segment.StartSec).ToArrayAsync();
        Check(keeper.Select(segment => segment.StartSec).SequenceEqual([1, 2, 5, 6]),
            "Generated segments, non-equivalent user markers, duration gate, or duplicate filtering failed.");
        Check(keeper.Single(segment => segment.StartSec == 2).SourceKey == "ext:ai.tagging",
            "Generated segment provenance was lost.");
        Check(keeper.Single(segment => segment.StartSec == 2).Payload?.RootElement.GetProperty("source").GetString() == "AI",
            "Generated segment payload was lost.");
        Check(await db.Segments.AsNoTracking().CountAsync(segment => segment.HostId == 2) == 3,
            "Preparation moved markers off a source before Cove resolved its deletion.");

        copied = await VideoSegmentTransfer.CopyForCleanupAsync(db, items, videos, CancellationToken.None);
        Check(copied == 0, "Repeating cleanup preparation duplicated keeper segments.");
        Console.WriteLine("Same-length video segment transfer passed.");
    }

    private static Segment Marker(int hostId, double start, string sourceKey) => new()
    {
        HostType = SegmentHostType.Video, HostId = hostId, StartSec = start, EndSec = start + 0.25,
        Kind = "chapter", SourceKey = sourceKey, SourceRunId = sourceKey == "user" ? null : "run-1",
        Confidence = sourceKey == "user" ? null : 0.9f,
        Payload = JsonDocument.Parse("{\"source\":\"AI\"}"),
    };

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}

using Cove.Core.Entities;
using Cove.Core.Interfaces;
using Cove.Data;
using Cove.DuplicateManager;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

internal static class PhotoRegressionTests
{
    internal static async Task RunAsync()
    {
        await using var db = new CoveContext(new DbContextOptionsBuilder<CoveContext>()
            .UseSqlite("Data Source=:memory:").Options);
        await db.Database.OpenConnectionAsync();
        await db.Database.EnsureCreatedAsync();
        db.Folders.AddRange(
            new Folder { Id = 1, Path = "/photos" },
            new Folder { Id = 2, Path = "/photos/other", ParentFolderId = 1 },
            new Folder { Id = 3, Path = "/photos/archive.zip", ParentFolderId = 1 });
        var untitledJpg = Image(5, null, 1, 1200, 1200, 2500, "1111111111111111", "unique-5");
        var untitledPng = Image(6, null, 1, 1200, 1200, 3500, "2222222222222222", "unique-6");
        var titledJpg = Image(7, "First title", 1, 1200, 1200, 2500, "4444444444444444", "unique-7");
        var titledPng = Image(8, "Second title", 1, 1200, 1200, 3500, "8888888888888888", "unique-8");
        untitledJpg.Files.Single().Basename = "holiday.jpg";
        untitledPng.Files.Single().Basename = "holiday.png";
        titledJpg.Files.Single().Basename = "another.jpg";
        titledPng.Files.Single().Basename = "another.png";
        db.Images.AddRange(
            Image(1, "Shared", 1, 1000, 1000, 1000, "0000000000000000", "same"),
            Image(2, "Shared", 2, 2000, 2000, 5000, "0000000000000001", "different"),
            Image(3, "Shared", 1, 2000, 2000, 3000, "0000000000000002", "same"),
            Image(4, "Other", 3, 500, 500, 600, "0000000000000000", "unique"),
            untitledJpg, untitledPng, titledJpg, titledPng);
        await db.SaveChangesAsync();

        var exact = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("fingerprint", "md5"), CancellationToken.None);
        Check(exact.Groups.Count == 1 && Ids(exact.Groups[0]).SequenceEqual([1, 3]),
            "Photo MD5 search did not match exact file fingerprints.");
        var visualExact = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("phash", PhashDistance: 0), CancellationToken.None);
        Check(visualExact.Groups.Count == 1 && Ids(visualExact.Groups[0]).SequenceEqual([1, 4]),
            "Photo pHash distance zero matched nonidentical hashes.");
        Check(visualExact.Groups[0].MatchedFiles.Any(file => file.InArchive),
            "Archive photo file was not marked as protected.");
        var visualNear = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("phash", PhashDistance: 1), CancellationToken.None);
        Check(visualNear.Groups.Count == 1 && Ids(visualNear.Groups[0]).SequenceEqual([1, 2, 3, 4]),
            "Nearby photo pHashes did not form one match group.");
        Check(visualNear.Groups[0].RecommendedKeeperId == 3,
            "Photo keeper did not prefer resolution, then smaller size.");
        Check(visualNear.Groups[0].MatchedFiles.All(file => file.ImageId is >= 1 and <= 4),
            "Matched photo files must identify their owning image for safe cleanup.");
        var title = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("title"), CancellationToken.None);
        Check(title.Groups.Count == 2 && title.Groups.Any(group => Ids(group).SequenceEqual([1, 2, 3]))
            && title.Groups.Any(group => Ids(group).SequenceEqual([5, 6])),
            "Photo title search did not use filenames for ordinary untitled scanned images.");
        var filename = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("filename"), CancellationToken.None);
        Check(filename.Groups.Count == 2 && filename.Groups.Any(group => Ids(group).SequenceEqual([5, 6]))
            && filename.Groups.Any(group => Ids(group).SequenceEqual([7, 8])),
            "Photo filename search did not match file stems independently of metadata titles.");
        var scoped = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("phash", PhashDistance: 1, IncludePaths: ["/photos/other"]), CancellationToken.None);
        Check(scoped.Groups.Count == 0, "Photo folder scope included other folders.");

        var sameRecord = Image(9, null, 1, 1200, 1200, 5000, "aaaaaaaaaaaaaaaa", "same-record");
        sameRecord.Files.Single().Basename = "single-record.jpg";
        sameRecord.Files.Add(new ImageFile
        {
            Id = 10, ParentFolderId = 1, Basename = "single-record.png", Width = 1200, Height = 1200, Size = 3000,
            Fingerprints = [new FileFingerprint { Type = "phash", Value = "aaaaaaaaaaaaaaaa" },
                new FileFingerprint { Type = "md5", Value = "same-record" }],
        });
        db.Images.Add(sameRecord);
        await db.SaveChangesAsync();
        var sameRecordMatches = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("filename"), CancellationToken.None);
        var fileGroup = sameRecordMatches.Groups.Single(group => group.Images.All(image => image.Id == 9));
        Check(fileGroup.Images.Select(image => image.File.Id).Order().SequenceEqual([9, 10])
            && fileGroup.RecommendedKeeperFileId == 10,
            "Files attached to one photo record were hidden or ranked incorrectly.");
        var sameRecordExact = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("fingerprint", "md5"), CancellationToken.None);
        Check(sameRecordExact.Groups.Any(group => group.Images.Select(image => image.File.Id).Order().SequenceEqual([9, 10])),
            "Exact duplicate files within one photo record were hidden.");

        var donor = await db.Images.SingleAsync(image => image.Id == 1);
        donor.Details = "Donor details";
        donor.Photographer = "Donor photographer";
        await db.SaveChangesAsync();
        await DuplicateDeletionJobService.MergeImageMetadataAsync(db, 3, [1], CancellationToken.None);
        var keeper = await db.Images.AsNoTracking().SingleAsync(image => image.Id == 3);
        Check(keeper.Title == "Shared" && keeper.Details == "Donor details"
            && keeper.Photographer == "Donor photographer", "Photo scalar metadata was not copied to the keeper.");
        Check(await db.ImageFiles.CountAsync(file => file.ImageId == 3) == 2,
            "Photo files were not attached to the keeper before pruning.");
        await DuplicateDeletionJobService.MergeImageMetadataAsync(db, 7, [8], CancellationToken.None, copyMetadata: false);
        Check((await db.Images.AsNoTracking().SingleAsync(image => image.Id == 7)).Title == "First title"
            && await db.ImageFiles.CountAsync(file => file.ImageId == 7) == 2,
            "Records-only photo cleanup must retain the keeper's metadata and attach source files.");
        var overwriteDonor = await db.Images.SingleAsync(image => image.Id == 2);
        overwriteDonor.Details = "Preferred source details";
        await db.SaveChangesAsync();
        await DuplicateDeletionJobService.MergeImageMetadataAsync(db, 3, [2], CancellationToken.None,
            overwriteConflictingMetadata: true);
        Check((await db.Images.AsNoTracking().SingleAsync(image => image.Id == 3)).Details == "Preferred source details",
            "Photo metadata overwrite did not prefer a source value.");
        var legacyRequest = JsonSerializer.Deserialize<ImageDeletionJobRequest>(
            """{"targetImageId":3,"sourceImageIds":[2],"fileIds":[22]}""",
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Check(legacyRequest is { DeleteFiles: true, DeleteGenerated: true, CopyMetadata: true },
            "Existing single-group photo cleanup requests lost their original defaults.");
        var service = new DuplicateDeletionJobService(null!, new StubJobs(), null!);
        var batch = service.StartImageBatchJob(new ImageBatchDeletionJobRequest([
            new ImageDeletionJobRequest(10, [11], [101]),
            new ImageDeletionJobRequest(20, [21], [201]),
        ]));
        Check(batch.Total == 2 && batch.MediaType == "image", "Bulk photo cleanup did not queue one job for both groups.");
        Check(service.StartImageBatchJob(new ImageBatchDeletionJobRequest([
            new ImageDeletionJobRequest(9, [], [9]),
        ])).Total == 1, "Photo file duplicates within one record could not be queued for cleanup.");
        try
        {
            service.StartImageBatchJob(new ImageBatchDeletionJobRequest([
                new ImageDeletionJobRequest(10, [11], [101]),
                new ImageDeletionJobRequest(20, [11], [201]),
            ]));
            throw new InvalidOperationException("Overlapping photo groups were accepted for bulk cleanup.");
        }
        catch (ArgumentException) { }
        Console.WriteLine("Photo fingerprint, pHash, title/filename, folder scope, ranking and metadata checks passed.");
    }

    private static Image Image(int id, string? title, int folderId, int width, int height, long size, string phash, string md5)
        => new()
        {
            Id = id, Title = title,
            Files = [new ImageFile
            {
                Id = id, ParentFolderId = folderId, Basename = $"photo-{id}.jpg",
                Width = width, Height = height, Size = size,
                Fingerprints = [new FileFingerprint { Type = "phash", Value = phash },
                    new FileFingerprint { Type = "md5", Value = md5 }],
            }],
        };

    private static int[] Ids(PhotoDuplicateGroup group) => group.Images.Select(image => image.Id).Order().ToArray();
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private sealed class StubJobs : IJobService
    {
        public string Enqueue(string type, string description, Func<IJobProgress, CancellationToken, Task> work, bool exclusive = true)
            => "photo-cleanup-job";
        public string EnqueueOwned(JobOwner owner, string type, string description, Func<IJobProgress, CancellationToken, Task> work,
            string? resultUrl = null, bool exclusive = true) => "photo-cleanup-job";
        public bool Cancel(string jobId) => false;
        public bool ReorderQueued(string jobId, string? beforeJobId) => false;
        public JobInfo? GetJob(string jobId) => null;
        public IReadOnlyList<JobInfo> GetAllJobs() => [];
        public IReadOnlyList<JobInfo> GetJobHistory() => [];
    }
}

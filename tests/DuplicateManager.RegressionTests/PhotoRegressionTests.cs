using Cove.Core.Entities;
using Cove.Data;
using Cove.DuplicateManager;
using Microsoft.EntityFrameworkCore;

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
        db.Images.AddRange(
            Image(1, "Shared", 1, 1000, 1000, 1000, "0000000000000000", "same"),
            Image(2, "Shared", 2, 2000, 2000, 5000, "0000000000000001", "different"),
            Image(3, "Shared", 1, 2000, 2000, 3000, "0000000000000002", "same"),
            Image(4, "Other", 3, 500, 500, 600, "0000000000000000", "unique"));
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
        Check(title.Groups.Count == 1 && Ids(title.Groups[0]).SequenceEqual([1, 2, 3]),
            "Photo title search did not group matching titles.");
        var scoped = await PhotoDuplicateSearch.FindAsync(db,
            new PhotoDuplicateSearchRequest("phash", PhashDistance: 1, IncludePaths: ["/photos/other"]), CancellationToken.None);
        Check(scoped.Groups.Count == 0, "Photo folder scope included other folders.");

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
        Console.WriteLine("Photo fingerprint, pHash, title, folder scope, ranking and metadata checks passed.");
    }

    private static Image Image(int id, string title, int folderId, int width, int height, long size, string phash, string md5)
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
}

using Cove.Core.Entities;
using Cove.Core.Interfaces;
using Cove.Data;
using Cove.DuplicateManager;
using Cove.DuplicateManager.Search;
using Microsoft.EntityFrameworkCore;

internal static class SearchRegressionTests
{
    internal static async Task RunAsync()
    {
        var budget = new DuplicateSearchMemoryBudget();
        for (var row = 0; row < 150_000; row++) budget.Reserve(1000, 1000, true);
        Check(DuplicateSearchMemoryBudget.NormalizeIds(Enumerable.Range(1, 100_001)).Length == 100_001,
            "Candidates above 100k were truncated.");
        Check(CoverPolicy.KeepTarget("saved-keeper", ["saved-source"]), "Curated keeper was replaced.");
        Check(CoverPolicy.KeepTarget("saved-keeper", [null]), "Generated source replaced curated keeper.");
        Check(!CoverPolicy.KeepTarget(null, [null, "saved-source"]), "Curated donor was lost.");
        Check(CoverPolicy.KeepTarget(null, [null]), "Generated frame was promoted to curated cover.");

        await using var db = new CoveContext(new DbContextOptionsBuilder<CoveContext>().UseSqlite("Data Source=:memory:").Options);
        await db.Database.OpenConnectionAsync();
        await db.Database.EnsureCreatedAsync();
        db.Videos.Add(new Video { Id = 1, Title = "Video 1" });
        await db.SaveChangesAsync();
        // Clone a valid seed row in SQL so this checks the actual candidate/row boundary
        // without spending minutes in unrelated per-entity denormalization hooks.
        var connection = db.Database.GetDbConnection();
        using var schema = connection.CreateCommand(); schema.CommandText = "PRAGMA table_info(videos)";
        var columns = new List<string>();
        using (var reader = await schema.ExecuteReaderAsync())
            while (await reader.ReadAsync()) columns.Add(reader.GetString(1));
        Check(columns.Count > 0, "Video schema was unavailable.");
        static string Quote(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
        var expressions = columns.Select(column => column.Equals("id", StringComparison.OrdinalIgnoreCase) ? "n"
            : column.Equals("title", StringComparison.OrdinalIgnoreCase) ? "CASE WHEN n=100001 THEN 'Video 1' ELSE 'Video ' || n END"
            : "template." + Quote(column));
        using var populate = connection.CreateCommand();
        populate.CommandText = "WITH RECURSIVE seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM seq WHERE n<100001) "
            + "INSERT INTO videos (" + string.Join(",", columns.Select(Quote)) + ") SELECT "
            + string.Join(",", expressions) + " FROM seq CROSS JOIN videos template WHERE template.id=1";
        await populate.ExecuteNonQueryAsync();
        db.ChangeTracker.Clear();
        var jobs = new CapturingJobs();
        var queued = await new DuplicateSearchJobService(db, jobs, null!).StartAsync(
            new JobOwner("user:1"), null, new DuplicateSearchStartRequest("title"), null, CancellationToken.None);
        Check(jobs.Owner?.Key == "user:1", "Search job owner was not preserved.");
        Check(queued.JobId == "search-job", "Search job id was not persisted.");
        var execution = new DuplicateSearchExecutionService(db, jobs, new CoveConfiguration());
        await execution.ExecuteAsync(queued.SearchId, null, new SilentProgress(), CancellationToken.None);
        var search = await db.DuplicateSearches.AsNoTracking().SingleAsync();
        Check(search.Status == DuplicateSearchStatus.Completed, "Large title search failed.");
        Check(search.CandidateCount == 100_001, "Large search did not consider every video.");
        var matched = await db.DuplicateSearchItems.AsNoTracking().Select(item => item.VideoId).Order().ToArrayAsync();
        Check(matched.SequenceEqual([1, 100_001]), "Cross-boundary duplicate was lost.");
        Console.WriteLine("Search passed with 100,001 videos and metadata rows; cover policy and owner checks passed.");

        db.Folders.Add(new Folder { Id = 1, Path = "/visual" });
        db.VideoFiles.AddRange(Enumerable.Range(1, 350).Select(id => new VideoFile
        {
            Id = id, VideoId = id, ParentFolderId = 1, Basename = $"{id}.mp4", Duration = 10,
            Fingerprints = [new FileFingerprint { Type = "phash", Value = "0000000000000000" }],
        }));
        await db.SaveChangesAsync(); db.ChangeTracker.Clear();
        var denseSearch = new DuplicateSearch { MatchType = "phash", Distance = 0, DurationDifference = 5 };
        db.DuplicateSearches.Add(denseSearch); await db.SaveChangesAsync();
        await execution.ExecuteAsync(denseSearch.Id, Enumerable.Range(1, 350).ToArray(), new SilentProgress(), CancellationToken.None);
        var denseItems = await db.DuplicateSearchItems.AsNoTracking().Where(item => item.Group!.SearchId == denseSearch.Id).ToListAsync();
        Check(denseItems.Select(item => item.VideoId).Distinct().Count() == 350, "Dense visual matches were truncated.");
        Check((await db.DuplicateSearches.AsNoTracking().SingleAsync(row => row.Id == denseSearch.Id)).Status == DuplicateSearchStatus.Completed,
            "Visual search above 25,000 matching pairs failed.");
        Console.WriteLine("Dense visual search with 61,075 matching pairs passed.");

        var chunks = DuplicateSearchExecutionService.SplitOversizedGroups([Enumerable.Range(1, 1001)]);
        Check(chunks.All(chunk => chunk.Length <= 50 && chunk.Contains(1)), "Large groups did not share a protected keeper.");
        var visual = DuplicateSearchExecutionService.FindPhashGroupsForTests([
            new DuplicatePHashCandidate(1, 10, 0), new DuplicatePHashCandidate(2, 10, 1),
            new DuplicatePHashCandidate(3, 30, 0),
        ], 1, 5);
        Check(visual.Groups.Count == 1 && visual.Groups[0].SequenceEqual([1, 2]), "Visual duration scope changed.");
        await CleanupRegressionTests.RunAsync(db);
        var cancelSearch = new DuplicateSearch { MatchType = "title" };
        db.DuplicateSearches.Add(cancelSearch); await db.SaveChangesAsync();
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        try { await execution.ExecuteAsync(cancelSearch.Id, null, new SilentProgress(), cancellation.Token); throw new Exception("Cancelled search ran."); }
        catch (OperationCanceledException) { }
        Check((await db.DuplicateSearches.AsNoTracking().SingleAsync(row => row.Id == cancelSearch.Id)).Status == DuplicateSearchStatus.Cancelled,
            "Cancelled status was not persisted.");
        Console.WriteLine("Group chunking, pHash duration and cancellation checks passed.");
    }

    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class SilentProgress : IJobProgress { public void Report(double progress, string? subTask = null) { } }
    private sealed class CapturingJobs : IJobService
    {
        public JobOwner? Owner { get; private set; }
        public string Enqueue(string type, string description, Func<IJobProgress, CancellationToken, Task> work, bool exclusive = true) => "search-job";
        public string EnqueueOwned(JobOwner owner, string type, string description, Func<IJobProgress, CancellationToken, Task> work,
            string? resultUrl = null, bool exclusive = true) { Owner = owner; return "search-job"; }
        public bool Cancel(string jobId) => false;
        public bool ReorderQueued(string jobId, string? beforeJobId) => false;
        public JobInfo? GetJob(string jobId) => null;
        public IReadOnlyList<JobInfo> GetAllJobs() => [];
        public IReadOnlyList<JobInfo> GetJobHistory() => [];
    }
}

using Microsoft.Extensions.DependencyInjection;
// Adapted from yourcove/cove (AGPL-3.0), commit e4f691eee80c57e3a01689661e7f409f559b5249.
using System.Collections.Concurrent;
using System.Globalization;
using System.Numerics;
using Cove.Core.Auth;
using Cove.Core.Common;
using Cove.Core.Entities;
using Cove.Core.Interfaces;
using Cove.Data;
using Microsoft.EntityFrameworkCore;

namespace Cove.DuplicateManager.Search;

public sealed class DuplicateSearchJobService(
    CoveContext db,
    IJobService jobService,
    IServiceScopeFactory scopeFactory)
{
    internal const int MaximumPHashDistance = 64;
    /// <summary>
    /// The match type that reviews the files attached to one video instead of separate videos. Its groups
    /// hold <see cref="DuplicateSearchFileItem"/> members and resolve by changing files, never whole videos.
    /// </summary>
    internal const string FilesMatchType = "files";
    internal const int MaximumScopePathCharacters = 1_048_576;
    internal static readonly TimeSpan ResultRetention = TimeSpan.FromDays(7);

    public async Task<DuplicateSearchStarted> StartAsync(
        JobOwner? owner,
        CovePrincipal? principal,
        DuplicateSearchStartRequest request,
        IReadOnlyCollection<int>? candidateVideoIds,
        CancellationToken ct)
    {
        var ids = candidateVideoIds is null ? null : DuplicateSearchMemoryBudget.NormalizeIds(candidateVideoIds);
        var matchType = NormalizeMatchType(request.MatchType);
        var search = new DuplicateSearch
        {
            OwnerKey = owner?.Key,
            MatchType = matchType,
            Distance = Math.Clamp(request.Distance, 0, MaximumPHashDistance),
            DurationDifference = Math.Clamp(request.DurationDiff ?? 5, 0, 86_400),
            IncludePaths = NormalizeScopePaths(request.IncludePaths),
            ExcludePaths = NormalizeScopePaths(request.ExcludePaths),
            MinimumDuration = Math.Clamp(request.MinimumDuration, 0, 86_400_000),
            KeeperRulesJson = DuplicateKeeperRules.Serialize(DuplicateKeeperRules.Normalize(request.KeeperRules)),
            CandidateCount = ids?.Length ?? 0,
            Status = DuplicateSearchStatus.Pending,
            ExpiresAt = DateTime.UtcNow.Add(ResultRetention),
        };
        db.DuplicateSearches.Add(search);
        await db.SaveChangesAsync(ct);

        var resultUrl = $"/duplicates?search={search.Id:D}";
        var work = CreateExecutionWork(scopeFactory, search.Id, ids, principal);

        var description = matchType == FilesMatchType
            ? "Finding videos with more than one file"
            : $"Finding duplicate videos by {DescribeMatchType(matchType)}";
        var jobId = owner is null
            ? jobService.EnqueueWithResult("duplicate-search", description, work, resultUrl)
            : jobService.EnqueueOwned(owner, "duplicate-search", description, work, resultUrl);
        search.JobId = jobId;
        // The job is already observable at this point. Persist its durable link even if the request
        // disconnects after receiving the enqueue side effect.
        await db.SaveChangesAsync(CancellationToken.None);
        return new DuplicateSearchStarted(search.Id, jobId, search.CandidateCount);
    }

    private static Func<IJobProgress, CancellationToken, Task> CreateExecutionWork(
        IServiceScopeFactory executionScopeFactory,
        Guid searchId,
        IReadOnlyCollection<int>? candidateVideoIds,
        CovePrincipal? principal)
        => async (progress, jobCt) =>
        {
            using var scope = executionScopeFactory.CreateScope();
            var scopedPrincipalAccessor = scope.ServiceProvider.GetRequiredService<ICurrentPrincipalAccessor>();
            var previousPrincipal = scopedPrincipalAccessor.Current;
            scopedPrincipalAccessor.Set(principal);
            var execution = scope.ServiceProvider.GetRequiredService<DuplicateSearchExecutionService>();
            try
            {
                await execution.ExecuteAsync(searchId, candidateVideoIds, progress, jobCt);
            }
            finally
            {
                scopedPrincipalAccessor.Set(previousPrincipal);
            }
        };

    /// <summary>
    /// Videos a resolution of the given groups would remove: members not kept in their group, in a group
    /// that still keeps someone, and not kept by any other group of the same search. Oversized logical
    /// groups are persisted as chunks sharing one keeper, so the cross-group rule is what lets every
    /// chunk remove its non-keepers without ever removing a video another chunk keeps.
    /// </summary>
    internal static IQueryable<int> EffectiveUnkeptVideoIds(
        CoveContext context,
        Guid searchId,
        IQueryable<DuplicateSearchGroup>? groups = null)
    {
        var keptVideoIds = context.DuplicateSearchItems
            .Where(item => item.Group != null && item.Group.SearchId == searchId && item.Keep)
            .Select(item => item.VideoId);
        var groupIds = (groups ?? context.DuplicateSearchGroups.Where(group => group.SearchId == searchId))
            .Select(group => group.Id);
        return context.DuplicateSearchItems
            .Where(item => item.Group != null
                && item.Group.SearchId == searchId
                && groupIds.Contains(item.GroupId)
                && !item.Keep
                && item.Group.Items.Any(keeper => keeper.Keep)
                && !keptVideoIds.Contains(item.VideoId))
            .Select(item => item.VideoId)
            .Distinct();
    }

    internal static string NormalizeMatchType(string? matchType)
        => matchType?.Trim().ToLowerInvariant() switch
        {
            "phash" or "visual" => "phash",
            "title" => "title",
            "remoteid" or "remote-id" or "remote_id" => "remoteId",
            "files" or "same-video" or "same_video" => FilesMatchType,
            _ => "fingerprint",
        };

    internal static string[] NormalizeScopePaths(IReadOnlyList<string>? paths)
    {
        var normalizedPaths = new List<string>();
        var distinctPaths = new HashSet<string>(FilesystemPaths.PathComparer);
        var retainedCharacters = 0;
        foreach (var rawPath in paths ?? [])
        {
            DuplicateSearchMemoryBudget.CheckFieldLength(rawPath?.Length ?? 0);
            var path = (rawPath ?? string.Empty).Trim().Replace('\\', '/').TrimEnd('/');
            if (path.Length == 0 || !distinctPaths.Add(path))
                continue;

            retainedCharacters += path.Length;
            if (retainedCharacters > MaximumScopePathCharacters)
                throw new InvalidOperationException($"Duplicate search scope paths exceed the {MaximumScopePathCharacters:N0}-character total limit. Use fewer or shorter paths and try again.");
            normalizedPaths.Add(path);
        }
        return normalizedPaths.ToArray();
    }

    internal static bool IsAtOrBelow(string candidatePath, string folder)
    {
        var candidate = candidatePath.Replace('\\', '/');
        return candidate.Equals(folder, FilesystemPaths.PathComparison)
            || candidate.StartsWith(folder + "/", FilesystemPaths.PathComparison);
    }

    private static string DescribeMatchType(string matchType) => matchType switch
    {
        "phash" => "visual similarity",
        "title" => "title",
        "remoteId" => "remote ID",
        FilesMatchType => "files on the same video",
        _ => "file fingerprint",
    };
}

public sealed class DuplicateSearchExecutionService(
    CoveContext db,
    IJobService jobService,
    CoveConfiguration config)
{
    private const int QueryChunkSize = 4_000;
    private const int PersistGroupBatchSize = 250;
    private const int PersistItemBatchSize = 1_000;
    /// <summary>Buckets larger than this are unioned linearly; per-pair ignore checks would be quadratic.</summary>
    private const int MaximumPairwiseBucketSize = 200;
    internal const int MaximumPersistedGroupSize = 50;
    internal const int MaximumPersistedGroupCount = int.MaxValue;

    public async Task ExecuteAsync(
        Guid searchId,
        IReadOnlyCollection<int>? candidateVideoIds,
        IJobProgress progress,
        CancellationToken ct)
    {
        try
        {
            // Retention cleanup belongs to background execution; a large cascade must never delay the
            // request whose only responsibility is to durably enqueue this search.
            var now = DateTime.UtcNow;
            var expiredSearches = db.DuplicateSearches
                .Where(item => item.Id != searchId && item.ExpiresAt < now && item.DeletionJobId == null);
            if (db.Database.IsRelational())
            {
                await expiredSearches.ExecuteDeleteAsync(ct);
            }
            else
            {
                // EF's in-memory provider cannot translate ExecuteDelete. Keeping this fallback also
                // makes the execution service usable by lightweight embedders and deterministic tests.
                db.DuplicateSearches.RemoveRange(await expiredSearches.ToListAsync(ct));
                await db.SaveChangesAsync(ct);
            }

            var search = await db.DuplicateSearches.FirstOrDefaultAsync(item => item.Id == searchId, ct)
                ?? throw new InvalidOperationException("The duplicate search no longer exists.");
            search.Status = DuplicateSearchStatus.Running;
            search.StartedAt = DateTime.UtcNow;
            search.Error = null;
            await db.SaveChangesAsync(ct);

            var memoryBudget = new DuplicateSearchMemoryBudget();
            progress.Report(0.01, "Loading videos in scope");
            var ids = candidateVideoIds is null
                ? await ResolveCandidateIdsAsync(search, memoryBudget, ct)
                : DuplicateSearchMemoryBudget.NormalizeIds(candidateVideoIds);
            DuplicateSearchMemoryBudget.CheckVideoCount(ids.Length);
            search.CandidateCount = ids.Length;
            await db.SaveChangesAsync(ct);

            if (search.MatchType == DuplicateSearchJobService.FilesMatchType)
            {
                progress.Report(0.1, "Finding videos with more than one file");
                var fileGroups = await FindMultiFileGroupsAsync(ids, memoryBudget, ct);
                ct.ThrowIfCancellationRequested();
                progress.Report(0.9, "Choosing files to keep");
                var fileGroupCount = await PersistFileGroupsAsync(
                    searchId,
                    fileGroups,
                    DuplicateKeeperRules.Deserialize(search.KeeperRulesJson),
                    memoryBudget,
                    progress,
                    ct);
                progress.Report(1, $"Found {fileGroupCount.ToString(CultureInfo.InvariantCulture)} videos with more than one file");
                return;
            }

            progress.Report(0.03, "Loading pairs marked as not duplicates");
            var ignored = await LoadIgnoredPairsAsync(ids, memoryBudget, ct);

            List<List<int>> groups;
            switch (search.MatchType)
            {
                case "phash":
                    groups = await FindPhashGroupsAsync(ids, search.Distance, search.DurationDifference, ignored, memoryBudget, progress, ct);
                    break;
                case "title":
                    progress.Report(0.1, "Comparing video titles");
                    groups = await FindTitleGroupsAsync(ids, ignored, memoryBudget, ct);
                    break;
                case "remoteId":
                    progress.Report(0.1, "Comparing remote IDs");
                    groups = await FindRemoteIdGroupsAsync(ids, ignored, memoryBudget, ct);
                    break;
                default:
                    progress.Report(0.1, "Comparing file fingerprints");
                    groups = await FindFingerprintGroupsAsync(ids, ignored, memoryBudget, ct);
                    break;
            }

            ct.ThrowIfCancellationRequested();
            progress.Report(0.9, "Choosing keepers");
            var persistedGroupCount = await PersistGroupsAsync(
                searchId,
                groups,
                DuplicateKeeperRules.Deserialize(search.KeeperRulesJson),
                memoryBudget,
                progress,
                ct);
            progress.Report(1, $"Found {persistedGroupCount.ToString(CultureInfo.InvariantCulture)} duplicate groups");
        }
        catch (OperationCanceledException)
        {
            await SetTerminalStatusAsync(searchId, DuplicateSearchStatus.Cancelled, null);
            throw;
        }
        catch (Exception ex)
        {
            await SetTerminalStatusAsync(searchId, DuplicateSearchStatus.Failed, ex.Message);
            throw;
        }
    }

    private async Task<int[]> ResolveCandidateIdsAsync(
        DuplicateSearch search,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var includes = search.IncludePaths ?? [];
        var excludes = search.ExcludePaths ?? [];
        foreach (var path in includes.Concat(excludes))
            DuplicateSearchMemoryBudget.CheckFieldLength(path.Length);
        var minimumDuration = search.MinimumDuration;
        var videoQuery = db.Videos.AsNoTracking();
        if (minimumDuration > 0)
            videoQuery = videoQuery.Where(video => video.MaxDuration >= minimumDuration);
        if (includes.Length == 0 && excludes.Length == 0)
        {
            // Title and remote-ID matching also apply to metadata-only videos, so an unscoped search
            // must not require a file.
            return await videoQuery
                .OrderBy(video => video.Id)
                .Select(video => video.Id)
                
                .ToArrayAsync(ct);
        }

        var ids = new HashSet<int>();
        var files = db.VideoFiles
            .AsNoTracking()
            .Where(file => file.VideoId.HasValue)
            .Join(videoQuery, file => file.VideoId!.Value, video => video.Id,
                (file, video) => new
                {
                    SourceId = file.Id,
                    VideoId = video.Id,
                    Path = file.Path.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters
                        ? file.Path.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1)
                        : file.Path,
                })
            .OrderBy(file => file.SourceId)
            .AsAsyncEnumerable();
        await foreach (var file in files.WithCancellation(ct))
        {
            DuplicateSearchMemoryBudget.CheckFieldLength(file.Path.Length);
            if ((includes.Length == 0 || includes.Any(folder => DuplicateSearchJobService.IsAtOrBelow(file.Path, folder)))
                && !excludes.Any(folder => DuplicateSearchJobService.IsAtOrBelow(file.Path, folder)))
            {
                ids.Add(file.VideoId);
                if (ids.Count > DuplicateSearchMemoryBudget.MaximumVideos)
                    break;
            }
        }
        return ids.Order().ToArray();
    }

    private async Task<HashSet<(int Low, int High)>> LoadIgnoredPairsAsync(
        int[] candidateIds,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var candidates = candidateIds.ToHashSet();
        var result = new HashSet<(int Low, int High)>();
        foreach (var chunk in candidateIds.Chunk(QueryChunkSize))
        {
            var pairs = db.DuplicateIgnoredPairs
                .AsNoTracking()
                .Where(pair => chunk.Contains(pair.LowVideoId))
                .Select(pair => new { pair.LowVideoId, pair.HighVideoId })
                .AsAsyncEnumerable();
            await foreach (var pair in pairs.WithCancellation(ct))
            {
                if (candidates.Contains(pair.HighVideoId) && result.Add((pair.LowVideoId, pair.HighVideoId)))
                    memoryBudget.ReserveIgnoredPair();
            }
        }
        return result;
    }

    private async Task<List<List<int>>> FindFingerprintGroupsAsync(
        int[] candidateVideoIds,
        HashSet<(int Low, int High)> ignored,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var rows = new List<DuplicateFingerprintCandidate>();
        foreach (var chunk in candidateVideoIds.Chunk(QueryChunkSize))
        {
            var query = db.VideoFiles
                .Where(file => file.VideoId.HasValue && chunk.Contains(file.VideoId.Value))
                .SelectMany(
                    file => file.Fingerprints.Where(fingerprint =>
                        (fingerprint.Type == "oshash" || fingerprint.Type == "md5")
                        && fingerprint.Value != ""),
                    (file, fingerprint) => new { SourceId = fingerprint.Id, VideoId = file.VideoId!.Value, fingerprint.Type, Value = fingerprint.Value.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters ? fingerprint.Value.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1) : fingerprint.Value })
                .AsNoTracking();
            await foreach (var row in ReadCandidatePagesAsync(query, row => row.SourceId, memoryBudget,
                row => (row.Type.Length + row.Value.Length, Math.Max(row.Type.Length, row.Value.Length)), false, ct))
                rows.Add(new DuplicateFingerprintCandidate(row.VideoId, row.Type, row.Value));
        }

        return GroupBuckets(
            rows.GroupBy(row => (row.Type, row.Value)).Select(bucket => bucket.Select(row => row.VideoId)),
            ignored,
            memoryBudget);
    }

    private async Task<List<List<int>>> FindTitleGroupsAsync(
        int[] candidateVideoIds,
        HashSet<(int Low, int High)> ignored,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var rows = new List<DuplicateTitleCandidate>();
        foreach (var chunk in candidateVideoIds.Chunk(QueryChunkSize))
        {
            var query = db.Videos
                .Where(video => chunk.Contains(video.Id) && video.Title != null && video.Title != "")
                .Select(video => new { SourceId = video.Id, VideoId = video.Id, Title = video.Title!.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters ? video.Title!.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1) : video.Title! })
                .AsNoTracking();
            await foreach (var row in ReadCandidatePagesAsync(query, row => row.SourceId, memoryBudget,
                row => (row.Title.Length, row.Title.Length), false, ct))
                rows.Add(new DuplicateTitleCandidate(row.VideoId, row.Title));
        }

        return GroupBuckets(
            rows.GroupBy(row => NormalizeTitle(row.Title), StringComparer.OrdinalIgnoreCase)
                .Where(bucket => bucket.Key.Length > 0)
                .Select(bucket => bucket.Select(row => row.VideoId)),
            ignored,
            memoryBudget);
    }

    private async Task<List<List<int>>> FindRemoteIdGroupsAsync(
        int[] candidateVideoIds,
        HashSet<(int Low, int High)> ignored,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var rows = new List<DuplicateRemoteIdCandidate>();
        foreach (var chunk in candidateVideoIds.Chunk(QueryChunkSize))
        {
            var query = db.Set<VideoRemoteId>()
                .Where(remoteId => chunk.Contains(remoteId.VideoId) && remoteId.RemoteId != "")
                .Select(remoteId => new
                {
                    SourceId = remoteId.Id,
                    remoteId.VideoId,
                    Endpoint = remoteId.Endpoint.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters ? remoteId.Endpoint.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1) : remoteId.Endpoint,
                    RemoteId = remoteId.RemoteId.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters ? remoteId.RemoteId.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1) : remoteId.RemoteId
                })
                .AsNoTracking();
            await foreach (var row in ReadCandidatePagesAsync(query, row => row.SourceId, memoryBudget,
                row => (row.Endpoint.Length + row.RemoteId.Length, Math.Max(row.Endpoint.Length, row.RemoteId.Length)), false, ct))
                rows.Add(new DuplicateRemoteIdCandidate(row.VideoId, row.Endpoint, row.RemoteId));
        }

        return GroupBuckets(
            rows.GroupBy(
                    row => $"{row.Endpoint.Trim()}\n{row.RemoteId.Trim()}",
                    StringComparer.OrdinalIgnoreCase)
                .Select(bucket => bucket.Select(row => row.VideoId)),
            ignored,
            memoryBudget);
    }

    private async Task<List<List<int>>> FindPhashGroupsAsync(
        int[] candidateVideoIds,
        int maxDistance,
        double maxDurationDifference,
        HashSet<(int Low, int High)> ignored,
        DuplicateSearchMemoryBudget memoryBudget,
        IJobProgress progress,
        CancellationToken ct)
    {
        progress.Report(0.04, "Loading visual fingerprints");
        var candidates = new List<DuplicatePHashCandidate>();
        foreach (var chunk in candidateVideoIds.Chunk(QueryChunkSize))
        {
            var query = db.VideoFiles
                .Where(file => file.VideoId.HasValue && chunk.Contains(file.VideoId.Value))
                .SelectMany(
                    file => file.Fingerprints.Where(fingerprint => fingerprint.Type == "phash" && fingerprint.Value != ""),
                    (file, fingerprint) => new { SourceId = fingerprint.Id, VideoId = file.VideoId!.Value, file.Duration, Value = fingerprint.Value.Length > DuplicateSearchMemoryBudget.MaximumFieldCharacters ? fingerprint.Value.Substring(0, DuplicateSearchMemoryBudget.MaximumFieldCharacters + 1) : fingerprint.Value })
                .AsNoTracking();
            await foreach (var row in ReadCandidatePagesAsync(query, row => row.SourceId, memoryBudget,
                row => (row.Value.Length, row.Value.Length), true, ct))
            {
                if (TryParsePHash(row.Value, out var hash))
                    candidates.Add(new DuplicatePHashCandidate(row.VideoId, row.Duration, hash));
            }
        }

        var sorted = candidates.OrderBy(candidate => candidate.Duration).ThenBy(candidate => candidate.VideoId).ToArray();
        progress.DeclareUnitCount(sorted.Length);
        if (sorted.Length < 2)
            return [];

        var index = new PHashMultiIndex(sorted, Math.Clamp(maxDistance, 0, 64));
        // Retain one union-find node per matched video rather than every matching pair.
        // Broad searches can have millions of pairs without needing millions of retained edges.
        var parent = new Dictionary<int, int>();
        var gate = new object();
        var result = await jobService.RunBatchAsync(
            Enumerable.Range(0, sorted.Length),
            (config.MaxParallelTasks == -1 ? Math.Max(1, Environment.ProcessorCount) : Math.Max(1, config.MaxParallelTasks)),
            (leftIndex, unit, innerCt) =>
            {
                CompareCandidate(index, leftIndex, Math.Clamp(maxDistance, 0, 64), Math.Max(0, maxDurationDifference),
                    (left, right) =>
                    {
                        var pair = left.VideoId < right.VideoId ? (left.VideoId, right.VideoId) : (right.VideoId, left.VideoId);
                        if (ignored.Contains(pair)) return;
                        lock (gate)
                        {
                            parent.TryAdd(left.VideoId, left.VideoId);
                            parent.TryAdd(right.VideoId, right.VideoId);
                            Union(parent, left.VideoId, right.VideoId);
                        }
                    }, null, innerCt);
                unit.Complete(JobUnitOutcome.Succeeded);
                return Task.CompletedTask;
            }, progress,
            unitIdFactory: (_, position) => position.ToString(CultureInfo.InvariantCulture),
            labelFactory: _ => "Comparing visual fingerprints", ct: ct);
        ct.ThrowIfCancellationRequested();
        if (result.FailedUnits > 0)
            throw new InvalidOperationException($"{result.FailedUnits.ToString(CultureInfo.InvariantCulture)} pHash comparison units failed.");
        return parent.Keys.GroupBy(id => Find(parent, id)).Select(group => group.Order().ToList())
            .Where(group => group.Count > 1).OrderBy(group => group[0]).ToList();
    }

    private async Task<int> PersistGroupsAsync(
        Guid searchId,
        IReadOnlyList<List<int>> groups,
        IReadOnlyList<DuplicateKeeperRule> rules,
        DuplicateSearchMemoryBudget memoryBudget,
        IJobProgress progress,
        CancellationToken ct)
    {
        var allVideoIds = groups.SelectMany(group => group).Distinct().ToArray();
        var facts = await DuplicateKeeperRules.LoadFactsAsync(db, allVideoIds, rules, memoryBudget, ct);
        var boundedGroups = PreparePersistedGroups(
            groups,
            MaximumPersistedGroupSize,
            MaximumPersistedGroupCount,
            ids => DuplicateKeeperRules.Choose(ids, facts, rules));

        progress.Report(0.94, "Saving duplicate groups");
        var existingGroups = db.DuplicateSearchGroups.Where(group => group.SearchId == searchId);
        if (db.Database.IsRelational())
        {
            await existingGroups.ExecuteDeleteAsync(ct);
        }
        else
        {
            db.DuplicateSearchGroups.RemoveRange(await existingGroups.ToListAsync(ct));
            await db.SaveChangesAsync(ct);
        }
        for (var batchStart = 0; batchStart < boundedGroups.Count; batchStart += PersistGroupBatchSize)
        {
            var batchEnd = Math.Min(batchStart + PersistGroupBatchSize, boundedGroups.Count);
            var definitions = new List<PersistedGroupDefinition>(batchEnd - batchStart);
            for (var position = batchStart; position < batchEnd; position++)
            {
                ct.ThrowIfCancellationRequested();
                var bounded = boundedGroups[position];
                definitions.Add(new PersistedGroupDefinition(
                    new DuplicateSearchGroup
                    {
                        SearchId = searchId,
                        Position = position,
                        Status = DuplicateGroupStatus.Unresolved,
                        DecisionSource = "auto",
                        DecisionRule = bounded.Choice.DecisionRule,
                    },
                    bounded.VideoIds,
                    bounded.Choice.KeeperId));
            }

            db.DuplicateSearchGroups.AddRange(definitions.Select(definition => definition.Entity));
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();

            var pendingItems = new List<DuplicateSearchItem>(PersistItemBatchSize);
            foreach (var definition in definitions)
            {
                foreach (var videoId in definition.VideoIds)
                {
                    pendingItems.Add(new DuplicateSearchItem
                    {
                        GroupId = definition.Entity.Id,
                        VideoId = videoId,
                        Keep = videoId == definition.KeeperId,
                    });
                    if (pendingItems.Count == PersistItemBatchSize)
                    {
                        db.DuplicateSearchItems.AddRange(pendingItems);
                        await db.SaveChangesAsync(ct);
                        db.ChangeTracker.Clear();
                        pendingItems.Clear();
                    }
                }
            }
            if (pendingItems.Count > 0)
            {
                db.DuplicateSearchItems.AddRange(pendingItems);
                await db.SaveChangesAsync(ct);
                db.ChangeTracker.Clear();
            }
        }

        var search = await db.DuplicateSearches.FirstAsync(item => item.Id == searchId, ct);
        search.Status = DuplicateSearchStatus.Completed;
        search.GroupCount = boundedGroups.Count;
        search.VideoCount = allVideoIds.Length;
        search.CompletedAt = DateTime.UtcNow;
        search.ExpiresAt = DateTime.UtcNow.Add(DuplicateSearchJobService.ResultRetention);
        search.Error = null;
        await db.SaveChangesAsync(ct);
        return boundedGroups.Count;
    }

    /// <summary>
    /// Groups the files of every candidate video that has more than one, leaving out pairs a person chose to
    /// keep side by side. A video's files can split into several groups when some of its pairs were kept.
    /// </summary>
    private async Task<List<DuplicateFileGroup>> FindMultiFileGroupsAsync(
        int[] candidateVideoIds,
        DuplicateSearchMemoryBudget memoryBudget,
        CancellationToken ct)
    {
        var filesByVideoId = new Dictionary<int, List<int>>();
        var videoIdByFileId = new Dictionary<int, int>();
        foreach (var chunk in candidateVideoIds.Chunk(QueryChunkSize))
        {
            // Only videos that actually have several files are read file by file.
            var multiFileVideoIds = await db.VideoFiles
                .AsNoTracking()
                .Where(file => file.VideoId.HasValue && chunk.Contains(file.VideoId.Value))
                .GroupBy(file => file.VideoId!.Value)
                .Where(files => files.Count() > 1)
                .Select(files => files.Key)
                .ToArrayAsync(ct);
            if (multiFileVideoIds.Length == 0)
                continue;

            var query = db.VideoFiles
                .AsNoTracking()
                .Where(file => file.VideoId.HasValue && multiFileVideoIds.Contains(file.VideoId.Value))
                .Select(file => new { file.Id, VideoId = file.VideoId!.Value });
            await foreach (var file in ReadCandidatePagesAsync(query, file => file.Id, memoryBudget, _ => (0, 0), false, ct))
            {
                if (!filesByVideoId.TryGetValue(file.VideoId, out var files))
                    filesByVideoId[file.VideoId] = files = [];
                files.Add(file.Id);
                videoIdByFileId[file.Id] = file.VideoId;
            }
        }

        var candidateFileIds = videoIdByFileId.Keys.ToHashSet();
        var ignored = new HashSet<(int Low, int High)>();
        foreach (var chunk in candidateFileIds.Order().Chunk(QueryChunkSize))
        {
            var pairs = db.DuplicateIgnoredFilePairs
                .AsNoTracking()
                .Where(pair => chunk.Contains(pair.LowFileId))
                .Select(pair => new { pair.LowFileId, pair.HighFileId })
                .AsAsyncEnumerable();
            await foreach (var pair in pairs.WithCancellation(ct))
            {
                if (candidateFileIds.Contains(pair.HighFileId) && ignored.Add((pair.LowFileId, pair.HighFileId)))
                    memoryBudget.ReserveIgnoredPair();
            }
        }

        // Each video is its own bucket, so a group can never mix files from different videos.
        return GroupBuckets(filesByVideoId.Values, ignored, memoryBudget)
            .Select(fileIds => new DuplicateFileGroup(videoIdByFileId[fileIds[0]], fileIds.ToArray()))
            .OrderBy(group => group.VideoId)
            .ThenBy(group => group.FileIds[0])
            .ToList();
    }

    /// <summary>
    /// Saves file groups with their chosen keeper. Unlike video groups they are never split into chunks:
    /// chunks share a keeper through the cross-group rule that only video resolution understands, and a
    /// video with more files than a page can show is still one decision about one video.
    /// </summary>
    private async Task<int> PersistFileGroupsAsync(
        Guid searchId,
        IReadOnlyList<DuplicateFileGroup> groups,
        IReadOnlyList<DuplicateKeeperRule> rules,
        DuplicateSearchMemoryBudget memoryBudget,
        IJobProgress progress,
        CancellationToken ct)
    {
        ThrowIfTooManyGroups(groups.Count, MaximumPersistedGroupCount);
        var allFileIds = groups.SelectMany(group => group.FileIds).Distinct().ToArray();
        var facts = await DuplicateKeeperRules.LoadFileFactsAsync(db, allFileIds, memoryBudget, ct);

        progress.Report(0.94, "Saving groups");
        var existingGroups = db.DuplicateSearchGroups.Where(group => group.SearchId == searchId);
        if (db.Database.IsRelational())
        {
            await existingGroups.ExecuteDeleteAsync(ct);
        }
        else
        {
            db.DuplicateSearchGroups.RemoveRange(await existingGroups.ToListAsync(ct));
            await db.SaveChangesAsync(ct);
        }

        for (var batchStart = 0; batchStart < groups.Count; batchStart += PersistGroupBatchSize)
        {
            var batch = groups
                .Skip(batchStart)
                .Take(PersistGroupBatchSize)
                .Select((group, offset) =>
                {
                    ct.ThrowIfCancellationRequested();
                    var choice = DuplicateKeeperRules.Choose(group.FileIds, facts, rules);
                    return (Group: group, Choice: choice, Entity: new DuplicateSearchGroup
                    {
                        SearchId = searchId,
                        Position = batchStart + offset,
                        Status = DuplicateGroupStatus.Unresolved,
                        DecisionSource = "auto",
                        DecisionRule = choice.DecisionRule,
                    });
                })
                .ToList();

            db.DuplicateSearchGroups.AddRange(batch.Select(entry => entry.Entity));
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();

            db.DuplicateSearchFileItems.AddRange(batch.SelectMany(entry => entry.Group.FileIds.Select(fileId => new DuplicateSearchFileItem
            {
                GroupId = entry.Entity.Id,
                FileId = fileId,
                VideoId = entry.Group.VideoId,
                Keep = fileId == entry.Choice.KeeperId,
            })));
            await db.SaveChangesAsync(ct);
            db.ChangeTracker.Clear();
        }

        var search = await db.DuplicateSearches.FirstAsync(item => item.Id == searchId, ct);
        search.Status = DuplicateSearchStatus.Completed;
        search.GroupCount = groups.Count;
        // A files search counts the files under review, since every group belongs to a single video.
        search.VideoCount = allFileIds.Length;
        search.CompletedAt = DateTime.UtcNow;
        search.ExpiresAt = DateTime.UtcNow.Add(DuplicateSearchJobService.ResultRetention);
        search.Error = null;
        await db.SaveChangesAsync(ct);
        return groups.Count;
    }

    private async Task SetTerminalStatusAsync(Guid searchId, DuplicateSearchStatus status, string? error)
    {
        db.ChangeTracker.Clear();
        var search = await db.DuplicateSearches.FirstOrDefaultAsync(item => item.Id == searchId, CancellationToken.None);
        if (search is null)
            return;
        search.Status = status;
        search.Error = string.IsNullOrWhiteSpace(error) ? null : error[..Math.Min(error.Length, 2_000)];
        search.CompletedAt = DateTime.UtcNow;
        search.ExpiresAt = DateTime.UtcNow.Add(DuplicateSearchJobService.ResultRetention);
        await db.SaveChangesAsync(CancellationToken.None);
    }

    internal static PhashGroupingResult FindPhashGroupsForTests(
        IReadOnlyCollection<DuplicatePHashCandidate> candidates,
        int maxDistance,
        double maxDurationDifference,
        IReadOnlySet<(int Low, int High)>? ignored = null)
    {
        var sorted = candidates.OrderBy(candidate => candidate.Duration).ThenBy(candidate => candidate.VideoId).ToArray();
        var index = new PHashMultiIndex(sorted, Math.Clamp(maxDistance, 0, 64));
        var matches = new HashSet<(int Left, int Right)>();
        long comparisons = 0;
        for (var leftIndex = 0; leftIndex < sorted.Length; leftIndex++)
        {
            CompareCandidate(
                index,
                leftIndex,
                Math.Clamp(maxDistance, 0, 64),
                Math.Max(0, maxDurationDifference),
                (left, right) =>
                {
                    var pair = left.VideoId < right.VideoId
                        ? (left.VideoId, right.VideoId)
                        : (right.VideoId, left.VideoId);
                    if (ignored?.Contains(pair) != true)
                        matches.Add(pair);
                },
                () => comparisons++,
                CancellationToken.None);
        }
        return new PhashGroupingResult(
            BuildConnectedGroups(matches),
            comparisons);
    }

    /// <summary>
    /// Connects every pair of videos that share a bucket (a fingerprint, a title, a remote ID) unless the
    /// pair was marked as not duplicates. Components rather than raw buckets become groups, so an MD5 match
    /// and an OSHash match of the same videos collapse into one group.
    /// </summary>
    internal static List<List<int>> GroupBuckets(
        IEnumerable<IEnumerable<int>> buckets,
        IReadOnlySet<(int Low, int High)> ignored,
        DuplicateSearchMemoryBudget? memoryBudget = null)
    {
        var ignoredVideoIds = new HashSet<int>();
        foreach (var pair in ignored)
        {
            ignoredVideoIds.Add(pair.Low);
            ignoredVideoIds.Add(pair.High);
        }
        return BuildConnectedGroups(EnumerateEdges(), memoryBudget);

        IEnumerable<(int Left, int Right)> EnumerateEdges()
        {
            foreach (var bucket in buckets)
            {
                var ids = bucket.Distinct().Order().ToArray();
                if (ids.Length < 2)
                    continue;
                var touchesIgnored = ids.Length <= MaximumPairwiseBucketSize && ids.Any(ignoredVideoIds.Contains);
                if (!touchesIgnored)
                {
                    for (var index = 1; index < ids.Length; index++)
                    {
                        yield return (ids[0], ids[index]);
                    }
                    continue;
                }
                for (var left = 0; left < ids.Length; left++)
                {
                    for (var right = left + 1; right < ids.Length; right++)
                    {
                        if (ignored.Contains((ids[left], ids[right])))
                            continue;
                        yield return (ids[left], ids[right]);
                    }
                }
            }
        }
    }

    internal static string NormalizeTitle(string title)
        => string.Join(' ', title.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static List<List<int>> BuildConnectedGroups(
        IEnumerable<(int Left, int Right)> matches,
        DuplicateSearchMemoryBudget? memoryBudget = null)
    {
        var parent = new Dictionary<int, int>();
        foreach (var (left, right) in matches)
        {
            if (parent.TryAdd(left, left))
                memoryBudget?.ReserveGroupingNode();
            if (parent.TryAdd(right, right))
                memoryBudget?.ReserveGroupingNode();
            Union(parent, left, right);
        }

        return parent.Keys
            .GroupBy(id => Find(parent, id))
            .Select(group => group.OrderBy(id => id).ToList())
            .Where(group => group.Count > 1)
            .OrderBy(group => group[0])
            .ToList();
    }

    private static int Find(IDictionary<int, int> parent, int id)
    {
        var root = id;
        while (parent[root] != root)
            root = parent[root];
        while (parent[id] != id)
        {
            var next = parent[id];
            parent[id] = root;
            id = next;
        }
        return root;
    }

    private static void Union(IDictionary<int, int> parent, int left, int right)
    {
        var leftRoot = Find(parent, left);
        var rightRoot = Find(parent, right);
        if (leftRoot == rightRoot)
            return;

        // Stable roots keep the resulting groups deterministic regardless of parallel edge order.
        if (leftRoot < rightRoot)
            parent[rightRoot] = leftRoot;
        else
            parent[leftRoot] = rightRoot;
    }

    internal static List<int[]> SplitOversizedGroups(
        IEnumerable<IEnumerable<int>> groups,
        int maximumGroupSize = MaximumPersistedGroupSize,
        int maximumGroupCount = MaximumPersistedGroupCount)
        => PreparePersistedGroups(
                groups,
                maximumGroupSize,
                maximumGroupCount,
                ids => new DuplicateKeeperChoice(ids.Min(), DuplicateKeeperRules.TieBreakRule))
            .Select(group => group.VideoIds)
            .ToList();

    private static List<BoundedDuplicateGroup> PreparePersistedGroups(
        IEnumerable<IEnumerable<int>> groups,
        int maximumGroupSize,
        int maximumGroupCount,
        Func<int[], DuplicateKeeperChoice> keeperSelector)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maximumGroupSize, 2);
        ArgumentOutOfRangeException.ThrowIfLessThan(maximumGroupCount, 1);
        var result = new List<BoundedDuplicateGroup>();
        foreach (var group in groups)
        {
            var ids = group.Distinct().OrderBy(id => id).ToArray();
            if (ids.Length < 2)
                continue;

            var choice = keeperSelector(ids);
            if (!ids.Contains(choice.KeeperId))
                throw new InvalidOperationException("The duplicate-group keeper must belong to its group.");

            if (ids.Length <= maximumGroupSize)
            {
                result.Add(new BoundedDuplicateGroup(ids, choice));
                ThrowIfTooManyGroups(result.Count, maximumGroupCount);
                continue;
            }

            // Each persisted chunk shares the logical group's keeper. The global kept-video rule can
            // therefore delete every other member even though the UI pages groups in bounded rows.
            foreach (var chunk in ids.Where(id => id != choice.KeeperId).Chunk(maximumGroupSize - 1))
            {
                result.Add(new BoundedDuplicateGroup([choice.KeeperId, .. chunk], choice));
                ThrowIfTooManyGroups(result.Count, maximumGroupCount);
            }
        }
        return result;
    }

    private static void ThrowIfTooManyGroups(int groupCount, int maximumGroupCount)
    {
        if (groupCount > maximumGroupCount)
        {
            throw new InvalidOperationException(
                $"The search found more than {maximumGroupCount.ToString("N0", CultureInfo.InvariantCulture)} duplicate groups. Narrow the search and try again.");
        }
    }

    private static void CompareCandidate(
        PHashMultiIndex index,
        int leftIndex,
        int maxDistance,
        double maxDurationDifference,
        Action<DuplicatePHashCandidate, DuplicatePHashCandidate> match,
        Action? comparisonCounter,
        CancellationToken ct)
    {
        var left = index.Candidates[leftIndex];
        HashSet<int>? seen = index.SegmentCount > 1 ? [] : null;
        for (var segment = 0; segment < index.SegmentCount; segment++)
        {
            ct.ThrowIfCancellationRequested();
            var bucket = index.GetBucket(segment, left.Hash);
            var position = bucket.BinarySearch(leftIndex);
            if (position < 0)
                continue;
            for (var bucketPosition = position + 1; bucketPosition < bucket.Count; bucketPosition++)
            {
                if ((bucketPosition & 1023) == 0) ct.ThrowIfCancellationRequested();
                var rightIndex = bucket[bucketPosition];
                var right = index.Candidates[rightIndex];
                if (right.Duration - left.Duration > maxDurationDifference)
                    break;
                if (seen is not null && !seen.Add(rightIndex))
                    continue;
                if (left.VideoId == right.VideoId)
                    continue;

                comparisonCounter?.Invoke();
                if (BitOperations.PopCount(left.Hash ^ right.Hash) <= maxDistance)
                    match(left, right);
            }
        }
    }

    private static bool TryParsePHash(string value, out ulong hash)
    {
        hash = 0;
        var normalized = value.Trim();
        if (normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            normalized = normalized[2..];
        return normalized.Length is > 0 and <= 16
            && normalized.All(Uri.IsHexDigit)
            && ulong.TryParse(normalized, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out hash);
    }

    private sealed class PHashMultiIndex
    {
        private readonly Dictionary<(int Segment, ulong Value), List<int>> _buckets = [];
        private readonly int[] _offsets;
        private readonly int[] _widths;

        public PHashMultiIndex(DuplicatePHashCandidate[] candidates, int maxDistance)
        {
            Candidates = candidates;
            SegmentCount = maxDistance >= 64 ? 1 : maxDistance + 1;
            _offsets = new int[SegmentCount];
            _widths = new int[SegmentCount];
            if (maxDistance < 64)
            {
                var baseWidth = 64 / SegmentCount;
                var remainder = 64 % SegmentCount;
                var offset = 0;
                for (var segment = 0; segment < SegmentCount; segment++)
                {
                    _offsets[segment] = offset;
                    _widths[segment] = baseWidth + (segment < remainder ? 1 : 0);
                    offset += _widths[segment];
                }
            }

            for (var candidateIndex = 0; candidateIndex < candidates.Length; candidateIndex++)
            {
                for (var segment = 0; segment < SegmentCount; segment++)
                {
                    var key = (segment, SegmentValue(candidates[candidateIndex].Hash, segment));
                    if (!_buckets.TryGetValue(key, out var bucket))
                    {
                        bucket = [];
                        _buckets[key] = bucket;
                    }
                    bucket.Add(candidateIndex);
                }
            }
        }

        public DuplicatePHashCandidate[] Candidates { get; }
        public int SegmentCount { get; }

        public List<int> GetBucket(int segment, ulong hash)
            => _buckets[(segment, SegmentValue(hash, segment))];

        private ulong SegmentValue(ulong hash, int segment)
        {
            var width = _widths[segment];
            var mask = width == 64 ? ulong.MaxValue : width == 0 ? 0 : (1UL << width) - 1;
            return (hash >> _offsets[segment]) & mask;
        }
    }

    private static async IAsyncEnumerable<T> ReadCandidatePagesAsync<T>(IQueryable<T> query, System.Linq.Expressions.Expression<Func<T, int>> identity,
        DuplicateSearchMemoryBudget budget, Func<T, (int Characters, int LargestField)> measure, bool visual,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var getId = identity.Compile();
        int? after = null;
        while (true)
        {
            var pageQuery = query;
            if (after.HasValue)
            {
                System.Linq.Expressions.Expression<Func<int>> cursor = () => after.Value;
                var predicate = System.Linq.Expressions.Expression.Lambda<Func<T, bool>>(
                    System.Linq.Expressions.Expression.GreaterThan(identity.Body, cursor.Body), identity.Parameters);
                pageQuery = pageQuery.Where(predicate);
            }
            var page = await pageQuery.OrderBy(identity).Take(DuplicateSearchMemoryBudget.PageSize).ToListAsync(ct);
            if (page.Count == 0) yield break;
            after = getId(page[^1]);
            foreach (var row in page)
            {
                ct.ThrowIfCancellationRequested();
                var size = measure(row);
                budget.Reserve(size.Characters, size.LargestField, visual);
                yield return row;
            }
        }
    }

    private sealed record DuplicateFingerprintCandidate(int VideoId, string Type, string Value);
    private sealed record DuplicateTitleCandidate(int VideoId, string Title);
    private sealed record DuplicateRemoteIdCandidate(int VideoId, string Endpoint, string RemoteId);
    private sealed record BoundedDuplicateGroup(int[] VideoIds, DuplicateKeeperChoice Choice);
    private sealed record DuplicateFileGroup(int VideoId, int[] FileIds);
    private sealed record PersistedGroupDefinition(DuplicateSearchGroup Entity, int[] VideoIds, int KeeperId);
}

internal readonly record struct DuplicatePHashCandidate(int VideoId, double Duration, ulong Hash);
internal sealed record PhashGroupingResult(IReadOnlyList<List<int>> Groups, long ComparisonCount);

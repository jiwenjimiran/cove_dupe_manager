using Cove.Core.Auth;
using Cove.Core.Entities;
using Cove.Core.Interfaces;
using Cove.Data;
using Cove.DuplicateManager.Search;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Cove.Plugins;
using Cove.Sdk;

namespace Cove.DuplicateManager;

public sealed partial class DuplicateManagerExtension
{
    private void MapSearchEndpoints(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/ext/duplicate-manager/videos/duplicate-searches", async (
            DuplicateSearchStartRequest request, HttpContext http, CancellationToken ct) =>
        {
            var principal = http.RequestServices.GetRequiredService<ICurrentPrincipalAccessor>().Current;
            if ((request.IncludePaths?.Count > 0 || request.ExcludePaths?.Count > 0
                || request.KeeperRules?.Any(rule => rule.Type == "path") == true)
                && principal?.Has(Permissions.FilesRead) != true)
                return Results.Forbid();
            var service = http.RequestServices.GetRequiredService<DuplicateSearchJobService>();
            var started = await service.StartAsync(JobOwner.FromPrincipal(principal), principal, request, null, ct);
            return Results.Accepted($"/api/videos/duplicate-searches/{started.SearchId}", started);
        }).RequireCovePermission("videos.read").RequireCovePermission("jobs.run");

        // Materialize the reviewed selection in Cove's durable format. The core resolve endpoint
        // authorizes and queues it, and its worker owns transactions, provenance and physical deletion.
        endpoints.MapPost("/api/ext/duplicate-manager/videos/cleanup-searches", PrepareCleanupAsync)
            .RequireCovePermission("videos.read").RequireCovePermission("videos.delete")
            .RequireCovePermission("jobs.run");
    }

    internal static async Task<IResult> PrepareCleanupAsync(VideoDeletionJobRequest request, HttpContext http, CancellationToken ct)
    {
        var items = request.Items?.Distinct().ToArray() ?? [];
        if (items.Length == 0 || items.Any(item => item.TargetId <= 0 || item.SourceId <= 0 || item.TargetId == item.SourceId)
            || items.GroupBy(item => item.SourceId).Any(group => group.Count() > 1)
            || items.Select(item => item.TargetId).Intersect(items.Select(item => item.SourceId)).Any())
            return Results.BadRequest(new { message = "Each source needs one keeper, and no keeper may be removed." });
        var principal = http.RequestServices.GetRequiredService<ICurrentPrincipalAccessor>().Current;
        if (request.CopyMetadata && principal?.Has(Permissions.VideosWrite) != true
            || request.DeleteFiles && principal?.Has(Permissions.VideosDeleteFile) != true)
            return Results.Forbid();
        var db = http.RequestServices.GetRequiredService<CoveContext>();
        var authorization = http.RequestServices.GetRequiredService<IAuthorizationService>();
        var ids = items.SelectMany(item => new[] { item.TargetId, item.SourceId }).Distinct().ToArray();
        var records = new Dictionary<int, Video>();
        foreach (var chunk in ids.Chunk(2000))
        {
            foreach (var video in await db.Videos.AsNoTracking().Where(video => chunk.Contains(video.Id)).ToListAsync(ct))
                records[video.Id] = video;
            foreach (var id in chunk)
                if (!(await authorization.AuthorizeAsync(principal, Permissions.VideosRead, EntityRef.Of(EntityKinds.Video, id), ct)).Allowed)
                    return Results.Forbid();
        }
        if (records.Count != ids.Length)
            return Results.Conflict(new { message = "A reviewed video no longer exists. Run the search again." });
        foreach (var item in items)
        {
            if (!(await authorization.AuthorizeAsync(principal, Permissions.VideosDelete, EntityRef.Of(EntityKinds.Video, item.SourceId), ct)).Allowed
                || request.CopyMetadata && !(await authorization.AuthorizeAsync(principal, Permissions.VideosWrite, EntityRef.Of(EntityKinds.Video, item.TargetId), ct)).Allowed)
                return Results.Forbid();
        }
        var search = new DuplicateSearch
        {
            OwnerKey = JobOwner.FromPrincipal(principal)?.Key,
            MatchType = "fingerprint", Status = DuplicateSearchStatus.Completed,
            CandidateCount = records.Count, VideoCount = records.Count,
            StartedAt = DateTime.UtcNow, CompletedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };
        db.DuplicateSearches.Add(search);
        var definitions = new List<(DuplicateSearchGroup Group, int TargetId, int[] SourceIds, Dictionary<string, string> Fields)>();
        foreach (var keeper in items.GroupBy(item => item.TargetId))
        {
            foreach (var chunk in keeper.Chunk(49))
            {
                var sourceIds = chunk.Select(item => item.SourceId).ToArray();
                var group = new DuplicateSearchGroup
                {
                    SearchId = search.Id, Position = definitions.Count,
                    Status = DuplicateGroupStatus.Unresolved, DecisionSource = "manual",
                    LastDecisionOperationId = Guid.NewGuid(),
                };
                group.Items.Add(new DuplicateSearchItem { VideoId = keeper.Key, Keep = true });
                foreach (var id in sourceIds) group.Items.Add(new DuplicateSearchItem { VideoId = id, Keep = false });
                var fields = new Dictionary<string, string>();
                if (request.OverwriteConflictingMetadata)
                {
                    foreach (var key in new[] { "title", "code", "details", "director", "date", "studioId", "captions", "organized", "isVr" })
                        if (sourceIds.Any(id => HasMergeValue(records[id], key))) fields[key] = "source";
                }
                // Cover policy is independent of scalar overwrite: keep an explicit keeper cover,
                // otherwise let core fill it from an explicit donor; never promote a generated frame.
                if (CoverPolicy.KeepTarget(records[keeper.Key].ImageBlobId, sourceIds.Select(id => records[id].ImageBlobId)))
                    fields["cover"] = "target";
                db.DuplicateSearchGroups.Add(group);
                definitions.Add((group, keeper.Key, sourceIds, fields));
            }
        }
        search.GroupCount = definitions.Count;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { searchId = search.Id, groups = definitions.Select(entry => new
        {
            id = entry.Group.Id, targetId = entry.TargetId, sourceIds = entry.SourceIds, metadata = new { fields = entry.Fields },
        }) });
    }

    private static bool HasMergeValue(Video video, string key) => key switch
    {
        "title" => !string.IsNullOrWhiteSpace(video.Title),
        "code" => !string.IsNullOrWhiteSpace(video.Code),
        "details" => !string.IsNullOrWhiteSpace(video.Details),
        "director" => !string.IsNullOrWhiteSpace(video.Director),
        "date" => video.Date.HasValue,
        "studioId" => video.StudioId.HasValue,
        "captions" => !string.IsNullOrWhiteSpace(video.Captions),
        _ => true,
    };
}

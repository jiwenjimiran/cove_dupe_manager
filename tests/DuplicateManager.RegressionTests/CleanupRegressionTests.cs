using System.Text.Json;
using Cove.Core.Auth;
using Cove.Core.Entities;
using Cove.Data;
using Cove.DuplicateManager;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

internal static class CleanupRegressionTests
{
    internal static async Task RunAsync(CoveContext db)
    {
        var accessor = new CurrentPrincipalAccessor();
        var principal = new CovePrincipal { UserId = 29, Username = "test", Kind = PrincipalKind.User,
            Roles = new HashSet<string>(), Permissions = new HashSet<string> { "videos.read", "videos.write", "videos.delete", "jobs.run" } };
        accessor.Set(principal);
        var authorization = new TestAuthorization();
        using var services = new ServiceCollection().AddSingleton(db).AddSingleton<ICurrentPrincipalAccessor>(accessor)
            .AddSingleton<IAuthorizationService>(authorization).BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        static VideoDeletionJobRequest Request(List<VideoDeletionJobItem> items, bool deleteFiles = false)
            => new(items, true, true, deleteFiles, true);
        static int Status(IResult result) => result is Microsoft.AspNetCore.Http.HttpResults.ForbidHttpResult ? 403
            : ((IStatusCodeHttpResult)result).StatusCode ?? 200;
        var before = await db.DuplicateSearches.CountAsync();
        var invalid = await DuplicateManagerExtension.PrepareCleanupAsync(Request([new(2, 3), new(3, 4)]), http, CancellationToken.None);
        Check(Status(invalid) == 400, "Cleanup allowed a keeper to be removed.");
        invalid = await DuplicateManagerExtension.PrepareCleanupAsync(Request([new(2, 3), new(4, 3)]), http, CancellationToken.None);
        Check(Status(invalid) == 400, "Cleanup allowed conflicting destinations.");
        var forbidden = await DuplicateManagerExtension.PrepareCleanupAsync(Request([new(2, 3)], deleteFiles: true), http, CancellationToken.None);
        Check(Status(forbidden) == 403, "Physical cleanup bypassed the file-deletion permission.");
        authorization.DeniedId = 3;
        forbidden = await DuplicateManagerExtension.PrepareCleanupAsync(Request([new(2, 3)]), http, CancellationToken.None);
        Check(Status(forbidden) == 403, "Entity read authorization was bypassed.");
        Check(await db.DuplicateSearches.CountAsync() == before, "Rejected selection persisted cleanup groups.");
        authorization.DeniedId = null;
        await db.Videos.Where(video => video.Id == 2).ExecuteUpdateAsync(update => update.SetProperty(video => video.ImageBlobId, "curated-keeper"));
        await db.Videos.Where(video => video.Id == 3).ExecuteUpdateAsync(update => update.SetProperty(video => video.ImageBlobId, "curated-donor"));
        db.ChangeTracker.Clear();
        var prepared = await DuplicateManagerExtension.PrepareCleanupAsync(
            Request(Enumerable.Range(3, 51).Select(id => new VideoDeletionJobItem(2, id)).ToList()), http, CancellationToken.None);
        Check(Status(prepared) == 200, "Valid cleanup selection was rejected.");
        var body = JsonSerializer.SerializeToElement(((IValueHttpResult)prepared).Value);
        var searchId = body.GetProperty("searchId").GetGuid();
        var search = await db.DuplicateSearches.AsNoTracking().SingleAsync(row => row.Id == searchId);
        Check(search.OwnerKey == "user:29" && search.GroupCount == 2, "Cleanup owner or group chunking was lost.");
        foreach (var group in body.GetProperty("groups").EnumerateArray())
            Check(group.GetProperty("metadata").GetProperty("fields").GetProperty("cover").GetString() == "target",
                "Metadata overwriting failed to preserve the curated keeper.");
        var groups = await db.DuplicateSearchGroups.AsNoTracking().Include(group => group.Items).Where(group => group.SearchId == searchId).ToListAsync();
        Check(groups.All(group => group.Items.Count <= 50 && group.Items.Single(item => item.Keep).VideoId == 2),
            "Cleanup did not persist the protected keeper in each chunk.");
        Check(groups.SelectMany(group => group.Items).Count(item => !item.Keep) == 51, "Cleanup selection lost sources.");
        accessor.Set(null);
        Console.WriteLine("Cleanup permission, keeper protection, curated-cover and persisted-group checks passed.");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private sealed class TestAuthorization : IAuthorizationService
    {
        public int? DeniedId { get; set; }
        public AuthorizationResult Authorize(CovePrincipal? principal, string permission, EntityRef? entity = null)
            => entity?.Id == DeniedId?.ToString() ? AuthorizationResult.Deny("test deny") : AuthorizationResult.Allow();
        public Task<AuthorizationResult> AuthorizeAsync(CovePrincipal? principal, string permission, EntityRef? entity, CancellationToken ct)
            => Task.FromResult(Authorize(principal, permission, entity));
        public void Require(CovePrincipal? principal, string permission, EntityRef? entity = null) { }
        public bool Has(CovePrincipal? principal, string permission) => principal?.Has(permission) == true;
    }
}

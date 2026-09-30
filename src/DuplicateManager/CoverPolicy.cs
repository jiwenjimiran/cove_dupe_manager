namespace Cove.DuplicateManager;

internal static class CoverPolicy
{
    // Metadata overwriting must never downgrade an explicitly saved cover to a generated frame.
    internal static bool KeepTarget(string? targetBlobId, IEnumerable<string?> sourceBlobIds)
        => !string.IsNullOrWhiteSpace(targetBlobId) || !sourceBlobIds.Any(id => !string.IsNullOrWhiteSpace(id));
}

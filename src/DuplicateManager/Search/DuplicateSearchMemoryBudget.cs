namespace Cove.DuplicateManager.Search;

// Compatibility with Cove's paged search implementation, without admission limits.
// Physical memory and cancellation determine how far a search can run.
internal sealed class DuplicateSearchMemoryBudget
{
    internal const int MaximumVideos = int.MaxValue;
    internal const int MaximumFieldCharacters = 4096;
    internal const int PageSize = 128;
    internal static int[] NormalizeIds(IEnumerable<int> ids) => ids.Where(id => id > 0).Distinct().ToArray();
    internal static void CheckVideoCount(int count) { }
    internal void Reserve(int characters, int largestField, bool visual) => CheckFieldLength(largestField);
    internal void ReserveIgnoredPair() { }
    internal void ReserveGroupingNode() { }
    internal void ReserveKeeperFact(int characters, int largestField) => CheckFieldLength(largestField);
    internal static void CheckFieldLength(int characters)
    {
        if (characters > MaximumFieldCharacters)
            throw new InvalidOperationException($"Duplicate search metadata exceeds the {MaximumFieldCharacters:N0}-character field limit.");
    }
}

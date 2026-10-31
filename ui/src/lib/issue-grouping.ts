export interface IssueTopicGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export function groupIssuesByTopic<
  T extends {
    id: string;
    title: string;
    labelIds?: string[] | null;
  },
>(
  issues: T[],
  labels?: Array<{ id: string; name: string }> | null,
  noTopicLabel = "Без темы",
): IssueTopicGroup<T>[] {
  const labelMap = new Map((labels ?? []).map((l) => [l.id, l.name]));
  const groups: Record<string, T[]> = {};
  const groupLabels = new Map<string, string>();

  for (const issue of issues) {
    const topicKeys: { key: string; label: string }[] = [];
    if (issue.labelIds && issue.labelIds.length > 0) {
      for (const labelId of issue.labelIds) {
        const labelName = labelMap.get(labelId) ?? labelId;
        topicKeys.push({ key: labelId, label: labelName });
      }
    }
    // Also support [Topic] prefix in title as topic
    const titleTopicMatch = issue.title.match(/^\[([^\]]+)\]/);
    if (titleTopicMatch && titleTopicMatch[1].trim()) {
      const rawTopic = titleTopicMatch[1].trim();
      topicKeys.push({ key: `title_topic:${rawTopic.toLowerCase()}`, label: rawTopic });
    }

    if (topicKeys.length === 0) {
      (groups.__no_topic ??= []).push(issue);
    } else {
      const seenKeys = new Set<string>();
      for (const { key, label } of topicKeys) {
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          (groups[key] ??= []).push(issue);
          groupLabels.set(key, label);
        }
      }
    }
  }

  return Object.keys(groups)
    .sort((a, b) => {
      if (a === "__no_topic") return 1;
      if (b === "__no_topic") return -1;
      const labelA = groupLabels.get(a) ?? a;
      const labelB = groupLabels.get(b) ?? b;
      return labelA.localeCompare(labelB);
    })
    .map((key) => ({
      key,
      label: key === "__no_topic" ? noTopicLabel : (groupLabels.get(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
}

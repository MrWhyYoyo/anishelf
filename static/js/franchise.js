// Grouping library entries that belong to the same series (franchise = several seasons).

const ACTIVE_ORDER = ['watching', 'on_hold', 'plan_to_watch'];

/**
 * The status that best describes a whole series:
 * watching > on hold > plan to watch > completed (only if every season is completed) > dropped.
 */
export function groupStatus(members) {
  for (const status of ACTIVE_ORDER) {
    if (members.some((m) => m.status === status)) return status;
  }
  if (members.every((m) => m.status === 'completed')) return 'completed';
  if (members.some((m) => m.status === 'dropped')) return 'dropped';
  return members[0] ? members[0].status : 'plan_to_watch';
}

const byUpdatedDesc = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at));

/**
 * Turn library entries into display items.
 * Each item: { key, lead, members, grouped, status, watched, total, totalKnown, progress, score,
 *              favorite, updated, added, series: {title, title_english} | null }
 */
export function buildItems(entries, groupSeasons) {
  const buckets = new Map();
  for (const entry of entries) {
    const franchise = entry.franchise;
    const key = groupSeasons && franchise && franchise.id ? `f${franchise.id}` : `a${entry.mal_id}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }

  return Array.from(buckets.entries()).map(([key, members]) => {
    members.sort(byUpdatedDesc);
    const lead = members[0];
    const grouped = members.length > 1;
    const watched = members.reduce((sum, m) => sum + (m.watched_count || 0), 0);
    const totals = members.map((m) => m.total);
    const totalKnown = totals.every((t) => typeof t === 'number' && t > 0);
    const total = totals.reduce((sum, t) => sum + (typeof t === 'number' ? t : 0), 0) || null;
    const scores = members.map((m) => m.score).filter((s) => typeof s === 'number');
    const franchise = lead.franchise;
    return {
      key,
      lead,
      members,
      grouped,
      status: grouped ? groupStatus(members) : lead.status,
      watched,
      total,
      totalKnown,
      progress: total && totalKnown ? Math.min(1, watched / total) : (grouped ? null : lead.progress),
      score: scores.length ? Math.max(...scores) : null,
      favorite: members.some((m) => m.favorite),
      updated: lead.updated_at,
      added: members.reduce((min, m) => (String(m.added_at) < String(min) ? m.added_at : min), lead.added_at),
      series: grouped && franchise ? { title: franchise.title || lead.meta.title, title_english: franchise.title_english || null } : null,
    };
  });
}

/** One entry per franchise (the most recently updated one); used by Home "Continue watching". */
export function onePerFranchise(entries) {
  const seen = new Set();
  return entries.slice().sort(byUpdatedDesc).filter((entry) => {
    const key = entry.franchise && entry.franchise.id ? `f${entry.franchise.id}` : `a${entry.mal_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

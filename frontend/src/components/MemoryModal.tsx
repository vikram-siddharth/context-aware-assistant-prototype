import { useState, useEffect, Fragment } from 'react';
import type { MemoryData } from '../types';
import { fetchMemories } from '../api/chat';

type Props = {
  open: boolean;
  onClose: () => void;
};

const CATEGORY_LABELS: Record<MemoryData['category'], string> = {
  constraint: 'Constraint',
  preference: 'Preference',
  goal: 'Goal',
};

const PERSISTENCE_LABELS: Record<MemoryData['persistence'], string> = {
  permanent: 'Permanent',
  long_term: 'Long-term',
  short_term: 'Short-term',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function getExpiryStatus(expiry: string | null): 'expired' | 'expiring-soon' | 'normal' {
  if (!expiry) return 'normal';
  const diff = new Date(expiry).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  if (diff <= TWO_WEEKS_MS) return 'expiring-soon';
  return 'normal';
}

function sortByExpiry(memories: MemoryData[]): MemoryData[] {
  return [...memories].sort((a, b) => {
    if (a.estimated_expiry && b.estimated_expiry) {
      return new Date(a.estimated_expiry).getTime() - new Date(b.estimated_expiry).getTime();
    }
    if (a.estimated_expiry) return -1;
    if (b.estimated_expiry) return 1;
    return 0;
  });
}

const CATEGORY_ORDER: MemoryData['category'][] = ['goal', 'preference', 'constraint'];

function groupByCategory(memories: MemoryData[]): { category: MemoryData['category']; items: MemoryData[] }[] {
  const sorted = sortByExpiry(memories);
  return CATEGORY_ORDER
    .map((cat) => ({ category: cat, items: sorted.filter((m) => m.category === cat) }))
    .filter((g) => g.items.length > 0);
}

export default function MemoryModal({ open, onClose }: Props) {
  const [groups, setGroups] = useState<{ category: MemoryData['category']; items: MemoryData[] }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setError(null);

    fetchMemories()
      .then((data) => setGroups(groupByCategory(data)))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="memory-modal__backdrop" onClick={onClose}>
      <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
        <div className="memory-modal__header">
          <h2>Notes I've taken to help you better</h2>
          <button className="memory-modal__close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="memory-modal__body">
          {loading && <p className="memory-modal__status">Loading...</p>}
          {error && <p className="memory-modal__status memory-modal__status--error">{error}</p>}
          {!loading && !error && groups.length === 0 && (
            <p className="memory-modal__status">No memories stored yet.</p>
          )}
          {!loading && !error && groups.length > 0 && (
            <table className="memory-modal__table">
              <thead>
                <tr>
                  <th className="memory-modal__th">Fact</th>
                  <th className="memory-modal__th">Persistence</th>
                  <th className="memory-modal__th">Expires</th>
                  <th className="memory-modal__th">Created</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <Fragment key={group.category}>
                    <tr>
                      <td
                        colSpan={4}
                        className={`memory-modal__group-heading memory-modal__group-heading--${group.category}`}
                      >
                        {CATEGORY_LABELS[group.category]}s
                      </td>
                    </tr>
                    {group.items.map((m) => {
                      const expiryStatus = getExpiryStatus(m.estimated_expiry);
                      return (
                        <tr
                          key={m.id}
                          className={expiryStatus !== 'normal' ? `memory-modal__row--${expiryStatus}` : undefined}
                        >
                          <td className="memory-modal__td memory-modal__td--fact">{m.fact}</td>
                          <td className="memory-modal__td">
                            <span className="memory-modal__badge memory-modal__badge--persistence">
                              {PERSISTENCE_LABELS[m.persistence]}
                            </span>
                          </td>
                          <td className={`memory-modal__td memory-modal__td--expiry${expiryStatus !== 'normal' ? ` memory-modal__td--${expiryStatus}` : ''}`}>
                            {m.estimated_expiry ? formatDate(m.estimated_expiry) : 'No expiry'}
                          </td>
                          <td className="memory-modal__td memory-modal__td--date">{formatDate(m.created_at)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

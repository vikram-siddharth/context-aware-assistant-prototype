import { useState, useEffect } from 'react';
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

export default function MemoryModal({ open, onClose }: Props) {
  const [memories, setMemories] = useState<MemoryData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setError(null);

    fetchMemories()
      .then(setMemories)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  return (
    <div className="memory-modal__backdrop" onClick={onClose}>
      <div className="memory-modal" onClick={(e) => e.stopPropagation()}>
        <div className="memory-modal__header">
          <h2>Memories</h2>
          <button className="memory-modal__close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="memory-modal__body">
          {loading && <p className="memory-modal__status">Loading...</p>}
          {error && <p className="memory-modal__status memory-modal__status--error">{error}</p>}
          {!loading && !error && memories.length === 0 && (
            <p className="memory-modal__status">No memories stored yet.</p>
          )}
          {!loading && !error && memories.length > 0 && (
            <ul className="memory-modal__list">
              {memories.map((m) => (
                <li key={m.id} className="memory-modal__item">
                  <p className="memory-modal__fact">{m.fact}</p>
                  <div className="memory-modal__meta">
                    <span className={`memory-modal__badge memory-modal__badge--${m.category}`}>
                      {CATEGORY_LABELS[m.category]}
                    </span>
                    <span className="memory-modal__badge memory-modal__badge--persistence">
                      {PERSISTENCE_LABELS[m.persistence]}
                    </span>
                    <span className="memory-modal__date">{formatDate(m.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

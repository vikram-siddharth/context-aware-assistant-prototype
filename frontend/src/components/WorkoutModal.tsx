import { useState, useEffect } from 'react';
import type { WorkoutData } from '../types';
import { fetchWorkouts } from '../api/chat';

type Props = {
  open: boolean;
  onClose: () => void;
  userId: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatType(type: string): string {
  return type
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export default function WorkoutModal({ open, onClose, userId }: Props) {
  const [workouts, setWorkouts] = useState<WorkoutData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setError(null);
    setExpandedId(null);

    fetchWorkouts(userId)
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );
        setWorkouts(sorted);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, userId]);

  if (!open) return null;

  const newestId =
    workouts.length > 0
      ? workouts.reduce((prev, curr) =>
          new Date(curr.created_at) > new Date(prev.created_at) ? curr : prev
        ).id
      : null;

  return (
    <div className="workout-modal__backdrop" onClick={onClose}>
      <div className="workout-modal" onClick={(e) => e.stopPropagation()}>
        <div className="workout-modal__header">
          <h2>Upcoming Workouts</h2>
          <button className="workout-modal__close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="workout-modal__body">
          {loading && <p className="workout-modal__status">Loading...</p>}
          {error && <p className="workout-modal__status workout-modal__status--error">{error}</p>}
          {!loading && !error && workouts.length === 0 && (
            <p className="workout-modal__status">No upcoming workouts scheduled.</p>
          )}
          {!loading && !error && workouts.length > 0 && (
            <ul className="workout-modal__list">
              {workouts.map((w) => {
                const hasDescription = w.description != null;
                const isExpanded = expandedId === w.id;

                return (
                  <li
                    key={w.id}
                    className={`workout-modal__item${hasDescription ? ' workout-modal__item--expandable' : ''}${isExpanded ? ' workout-modal__item--expanded' : ''}`}
                    onClick={hasDescription ? () => setExpandedId(isExpanded ? null : w.id) : undefined}
                  >
                    <div className="workout-modal__row">
                      <span className="workout-modal__type">{formatType(w.type)}</span>
                      <span className="workout-modal__duration">{w.duration} min</span>
                      <span className="workout-modal__date">{formatDate(w.date)}</span>
                      {w.id === newestId && (
                        <span className="workout-modal__badge">New</span>
                      )}
                    </div>
                    {isExpanded && w.description && (
                      <p className="workout-modal__description">{w.description}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

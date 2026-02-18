import type { ReasoningStepData } from '../types';

type Props = {
  step: ReasoningStepData;
};

export default function ReasoningStep({ step }: Props) {
  const isThinking = step.type === 'thinking';

  return (
    <div className={`reasoning-step reasoning-step--${step.type}`}>
      <span className="reasoning-step__icon">
        {isThinking ? '💭' : '⚡'}
      </span>
      <span className="reasoning-step__content">{step.content}</span>
    </div>
  );
}

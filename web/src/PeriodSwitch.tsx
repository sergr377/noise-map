import type { Period } from './api';
import { PERIODS } from './urlState';

interface Props {
  period: Period;
  onChange: (period: Period) => void;
  /** Nothing to switch between until a map is on screen. */
  disabled: boolean;
}

export default function PeriodSwitch({ period, onChange, disabled }: Props) {
  return (
    // <fieldset> brings its own border and padding, and this is a row of toggle
    // buttons rather than form fields: the role and the label give the same
    // semantics without rewriting the styles.
    // biome-ignore lint/a11y/useSemanticElements: the role stands in for fieldset on purpose
    <div className="periods" role="group" aria-label="Период суток">
      {PERIODS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={p.id === period ? 'active' : ''}
          onClick={() => onChange(p.id)}
          disabled={disabled}
        >
          {p.label}
          <span>{p.hint}</span>
        </button>
      ))}
    </div>
  );
}

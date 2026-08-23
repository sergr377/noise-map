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
    // <fieldset> тянет за собой собственную рамку и отступы, а группа здесь —
    // ряд кнопок-переключателей, а не поля формы: роль и подпись дают ту же
    // семантику, не заставляя переписывать стили.
    // biome-ignore lint/a11y/useSemanticElements: роль здесь вместо fieldset намеренно
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

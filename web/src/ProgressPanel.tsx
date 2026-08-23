import type { PreviewKind } from './useNoiseJob';

interface Props {
  /** 0..1, already smoothed — this component does not invent motion of its own. */
  progress: number;
  label: string;
  seconds: number;
  /** A cache hit has nothing to cancel and nothing to wait for. */
  fromCache: boolean;
  canCancel: boolean;
  onCancel: () => void;
  /** What is on the map right now, if anything stands in for the result. */
  previewKind: PreviewKind | null;
  /** Whether this pick replaced a calculation that is still running elsewhere. */
  superseded: boolean;
}

/** The bar, the clock, the cancel button and the notes that explain them. */
export default function ProgressPanel({
  progress,
  label,
  seconds,
  fromCache,
  canCancel,
  onCancel,
  previewKind,
  superseded,
}: Props) {
  return (
    <div className="progress" role="status">
      <div className="bar">
        <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="progress-text">
        <span>{label}</span>
        <span>
          {seconds} с
          {!fromCache && (
            <button type="button" className="cancel" onClick={onCancel} disabled={!canCancel}>
              Отменить
            </button>
          )}
        </span>
      </div>
      {previewKind === 'rough' && (
        <p className="note">
          Показана предварительная оценка: она учитывает только дороги ближе 75 м, поэтому уровни
          занижены на 2–3 дБ, а пятая часть площади попадёт в соседнюю полосу — во дворах сейчас
          тише, чем будет на точной карте. Точный расчёт заменит её целиком, не сдвигая контуров.
        </p>
      )}
      {previewKind === 'frame' && (
        <p className="note">
          Показана карта на текущий момент расчёта: чем дальше, тем больше закрашено. Итоговая
          заменит её целиком.
        </p>
      )}
      {superseded && (
        <p className="note">
          Предыдущий расчёт продолжается на сервере и попадёт в кэш — вернётесь к той точке,
          откроется сразу.
        </p>
      )}
      <p className="note">
        Первый расчёт для нового места занимает 6–27 минут: в плотной застройке дольше, на окраинах
        быстрее. Повторный клик рядом отдаётся из кэша мгновенно.
      </p>
    </div>
  );
}

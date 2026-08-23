import { BANDS } from './palette';

interface Props {
  /** Whether any map is on screen at all. */
  hasMap: boolean;
  /** Levels actually present in what is shown, for the current period. */
  presentLevels: Set<number>;
}

export default function Legend({ hasMap, presentLevels }: Props) {
  return (
    <div className="legend">
      <h2>Уровень, дБ(A)</h2>
      {/* Bands missing from a result are dimmed, but only once a result
          exists — before the first calculation nothing is "absent", and
          dimming the whole scale then just makes the legend look broken. */}
      <ul>
        {[...BANDS].reverse().map((band) => (
          <li key={band.level} className={!hasMap || presentLevels.has(band.level) ? '' : 'absent'}>
            <span className="swatch" style={{ background: band.color }} aria-hidden="true" />
            <span className="range">{band.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

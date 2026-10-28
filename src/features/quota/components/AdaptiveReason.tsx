import { useTranslation } from 'react-i18next';
import type { AdaptiveDecision } from '@/services/api';
import styles from './QuotaAccounts.module.scss';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Explanations come from the same backend decision that orders the real selector. */
export function AdaptiveReason({ decision, now }: { decision: AdaptiveDecision; now: number }) {
  const { t } = useTranslation();
  const windows = [
    { label: t('adaptive_routing.short'), value: decision.short },
    { label: t('adaptive_routing.long'), value: decision.long },
  ];
  const learning = windows.some(({ value }) => value?.learning);
  const age = Math.max(0, Math.floor((now - Date.parse(decision.observed_at)) / 60000));
  const observed = Number.isFinite(age) && !decision.observed_at.startsWith('0001-');
  return (
    <details className={styles.reason}>
      <summary>{t('adaptive_routing.details')}</summary>
      <p>
        {t(`adaptive_routing.explain.${decision.reason}`, {
          defaultValue: t('adaptive_routing.explain.unknown'),
        })}
      </p>
      <div className={styles.facts}>
        {decision.home && <span>{t('adaptive_routing.home')}</span>}
        <span>
          {t(decision.fresh && age <= 10 ? 'adaptive_routing.fresh' : 'adaptive_routing.stale', {
            minutes: observed ? age : '—',
          })}
        </span>
        <span>{t(learning ? 'adaptive_routing.learning' : 'adaptive_routing.learned')}</span>
        <span>
          {t('adaptive_routing.score', { score: decision.score.toFixed(3), band: decision.band })}
        </span>
      </div>
      <div className={styles.reasonTableWrap}>
        <table className={styles.reasonTable}>
          <thead>
            <tr>
              <th scope="col">{t('adaptive_routing.window')}</th>
              <th scope="col">{t('adaptive_routing.used')}</th>
              <th scope="col">{t('adaptive_routing.reserve')}</th>
              <th scope="col">{t('adaptive_routing.spare')}</th>
            </tr>
          </thead>
          <tbody>
            {windows.map(({ label, value }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value ? percent(value.used) : '—'}</td>
                <td>{value ? percent(value.reserve) : '—'}</td>
                <td>{value ? percent(value.spare) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {windows.map(
        ({ label, value }) =>
          value && (
            <p key={label} className={styles.formula}>
              {t('adaptive_routing.forecast', {
                window: label,
                demand: percent(value.forecast),
                buffer: percent(value.buffer),
                recent: percent(value.recent_rate),
                typical: percent(value.typical_rate),
              })}
              {value.inactive && <> {t('adaptive_routing.inactive')}</>}
            </p>
          )
      )}
    </details>
  );
}

import { useEffect, useRef, useState } from 'react';
import { fetchSources } from '../api';
import { APP_NAME } from '../brand';
import { CloseIcon, ExternalIcon } from './icons';
import type { SourceRow } from '../types';

/**
 * “Par datiem”. Every register the map reads, who owns it,
 * the licence and the endpoint — so nothing here is a black box.
 */
export function SourcesSheet({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  /*
   * Keyboard focus lands on the close button, the way a macOS sheet
   * takes focus. preventScroll keeps the spring entrance undisturbed.
   */
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    fetchSources()
      .then(setSources)
      .catch((err: unknown) =>
        setError(
          err instanceof Error
            ? err.message
            : 'Avotu sarakstu neizdevās ielādēt. Pārlādējiet lapu un mēģiniet vēlreiz.',
        ),
      );
  }, []);

  /* Escape closes the dialog, same as portal overlays. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div className="sheet glass" role="dialog" aria-modal="true" aria-label="Datu avoti" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>Datu avoti</h2>
            <p>
              {APP_NAME} nekrāj datus un neko nepērk. Katrs klikšķis vaicā tiešos valsts atvērto datu avotus — un
              katra atbildes rinda norāda uz ierakstu, ko Jūs varat atvērt un pārbaudīt. Datus, kas jau ir
              reģistros, Jums nav jāievada (once-only). Saskarne seko Latvija.gov.lv / VDAA e-pakalpojumu
              principiem; tā nav oficiāls portāla e-pakalpojums un nelieto VDAA Storybook SDK.
            </p>
          </div>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Aizvērt">
            <CloseIcon />
          </button>
        </header>

        {error ? <p className="banner">{error}</p> : null}

        <div className="sheet-list">
          {sources.map((source) => (
            <article key={source.id}>
              <h3>{source.name}</h3>
              <p className="owner">
                {source.owner} · {source.license} · {source.refresh}
              </p>
              <p>{source.reuse}</p>
              <p className="limits">{source.limits}</p>
              <p className="links">
                {source.proof ? (
                  <a href={source.proof} target="_blank" rel="noreferrer">
                    Datu kopa <ExternalIcon />
                  </a>
                ) : null}
                {source.api ? (
                  <a href={source.api} target="_blank" rel="noreferrer">
                    API <ExternalIcon />
                  </a>
                ) : null}
                {source.lastModified ? <span>CKAN atjaunots {source.lastModified.slice(0, 10)}</span> : null}
              </p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

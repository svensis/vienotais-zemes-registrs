import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { geocode } from '../api';
import { APP_NAME } from '../brand';
import { Logo, SearchIcon, CloseIcon } from './icons';
import type { GeocodeHit } from '../types';

interface Props {
  onNumber: (cadastre: string) => void;
  onAddress: (hit: GeocodeHit) => void;
  onInfo: () => void;
  /** Shown under the field when a lookup failed. */
  note: string;
}

/** 11–17 digits, with spaces or dashes tolerated, is a cadastre number. */
function asCadastre(value: string): string {
  if (!/^[\d\s-]+$/.test(value.trim())) {
    return '';
  }
  const digits = value.replace(/\D/g, '');
  return digits.length >= 11 && digits.length <= 17 ? digits : '';
}

/**
 * Nominatim leads with the house number ("1, Kaļķu iela, Vecrīga, …").
 * Latvians write the street first, so swap them: "Kaļķu iela 1".
 */
function splitLabel(label: string): { title: string; detail: string } {
  const parts = label.split(',').map((part) => part.trim());
  if (parts.length > 1 && /^\d+\s?[A-Za-zĀ-ž]?$/.test(parts[0])) {
    return { title: `${parts[1]} ${parts[0]}`, detail: parts.slice(2, 5).join(', ') };
  }
  return { title: parts[0], detail: parts.slice(1, 4).join(', ') };
}

/**
 * One field for both kinds of search. Digits go straight to
 * the parcel service; anything else is treated as an address and
 * geocoded with OpenStreetMap, with suggestions after a short pause.
 */
export function SearchBar({ onNumber, onAddress, onInfo, note }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<GeocodeHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState('');
  const serial = useRef(0);
  /* Choosing a suggestion rewrites the field; that must not trigger a new search. */
  const picked = useRef(false);

  /* Debounced address suggestions. Cadastre numbers skip this. */
  useEffect(() => {
    const text = query.trim();
    setProblem('');
    if (picked.current) {
      picked.current = false;
      return;
    }
    if (text.length < 4 || asCadastre(text)) {
      setHits([]);
      setBusy(false);
      return;
    }

    const current = ++serial.current;
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await geocode(text);
        if (current === serial.current) {
          setHits(found);
          setOpen(true);
          if (!found.length) {
            setProblem(
              'Adrese nav atrasta meklētājā. Precizējiet ielas nosaukumu un mājas numuru vai ievadiet kadastra numuru (11–17 cipari).',
            );
          }
        }
      } catch (error) {
        if (current === serial.current) {
          setHits([]);
          setProblem(
            error instanceof Error
              ? error.message
              : 'Meklēšana neizdevās. Pārbaudiet interneta savienojumu un mēģiniet vēlreiz.',
          );
        }
      } finally {
        if (current === serial.current) {
          setBusy(false);
        }
      }
    }, 520);

    return () => window.clearTimeout(timer);
  }, [query]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const cadastre = asCadastre(query);
    if (cadastre) {
      setOpen(false);
      onNumber(cadastre);
      return;
    }
    if (hits[0]) {
      pick(hits[0]);
    }
  }

  function pick(hit: GeocodeHit) {
    setOpen(false);
    setHits([]);
    picked.current = true;
    setQuery(splitLabel(hit.label).title);
    onAddress(hit);
  }

  const cadastre = asCadastre(query);

  return (
    <div className="search glass">
      <div className="brand">
        <Logo size={26} />
        <span className="brand-name">{APP_NAME}</span>
        <button type="button" className="info-btn" onClick={onInfo} aria-label="Par datiem un avotiem" title="Datu avoti">
          Dati
        </button>
      </div>

      {/* Baušlis 8: label as a call to action, not a static noun. */}
      <label className="search-label" htmlFor="zk-search">
        Ievadiet kadastra numuru vai adresi
      </label>
      <form onSubmit={submit} className="search-field" role="search">
        <SearchIcon />
        <input
          id="zk-search"
          value={query}
          onChange={(event) => {
            picked.current = false;
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Piemēram, 01000010023 vai Skārņu iela 7"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
        />
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {query ? (
          <button
            type="button"
            className="clear"
            onClick={() => {
              setQuery('');
              setHits([]);
            }}
            aria-label="Notīrīt"
          >
            <CloseIcon />
          </button>
        ) : null}
      </form>
      {!problem && !note ? (
        <p className="search-help">Klikšķiniet kartē vai meklējiet — dati nāk no valsts reģistriem, Jums nav jāievada tas, kas jau tur ir.</p>
      ) : null}

      {open && (cadastre || hits.length > 0) ? (
        <ul className="suggest" role="listbox">
          {cadastre ? (
            <li>
              <button type="button" onClick={() => onNumber(cadastre)}>
                <strong>Atvērt zemes vienību</strong>
                <span>{cadastre}</span>
              </button>
            </li>
          ) : null}
          {hits.map((hit) => (
            <li key={`${hit.lat},${hit.lon}`}>
              <button type="button" onClick={() => pick(hit)}>
                <strong>{splitLabel(hit.label).title}</strong>
                <span>{splitLabel(hit.label).detail}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {problem || note ? <p className="search-note">{problem || note}</p> : null}
    </div>
  );
}

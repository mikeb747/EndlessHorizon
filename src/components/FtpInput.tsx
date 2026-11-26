import { useEffect, useState } from 'react';
import { clampFtp, MAX_FTP, MIN_FTP } from '../logic/WorkoutEngine';

interface FtpInputProps {
  id: string;
  value: number;
  onChange: (ftp: number) => void;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

/**
 * Ergonomic numeric input for rider FTP (80–600 W).
 *
 * Keeps a local text draft while editing so users can freely clear or overwrite
 * values (e.g., replacing "80" with "315") without mid-keystroke clamping snapping
 * the box back to 80 after pressing "3". Valid in-range values commit live, while
 * out-of-range or partial entries clamp cleanly on blur or Enter.
 */
export function FtpInput({
  id,
  value,
  onChange,
  className = '',
  'data-testid': dataTestId,
  'aria-label': ariaLabel = 'Rider FTP in watts',
}: FtpInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const [isFocused, setIsFocused] = useState(false);

  // Sync draft when external value changes (e.g., ±5 stepper buttons or another screen)
  useEffect(() => {
    if (!isFocused) {
      setDraft(String(value));
    }
  }, [value, isFocused]);

  // Also sync if value changes via stepper while unfocused or after button click
  const displayedValue = isFocused ? draft : String(value);

  const commitDraft = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setDraft(String(value));
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = clampFtp(parsed);
    onChange(clamped);
    setDraft(String(clamped));
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      value={displayedValue}
      onFocus={(e) => {
        setIsFocused(true);
        setDraft(String(value));
        // Select all digits on focus so typing immediately overwrites cleanly
        e.currentTarget.select();
      }}
      onChange={(e) => {
        // Keep only digits so users can freely type "", "3", "31", "315", etc.
        const digitsOnly = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
        setDraft(digitsOnly);

        if (digitsOnly.length > 0) {
          const parsed = Number.parseInt(digitsOnly, 10);
          if (parsed >= MIN_FTP && parsed <= MAX_FTP) {
            onChange(parsed);
          }
        }
      }}
      onBlur={() => {
        setIsFocused(false);
        commitDraft(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commitDraft(draft);
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(String(value));
          setIsFocused(false);
          e.currentTarget.blur();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const next = clampFtp(value + 5);
          onChange(next);
          setDraft(String(next));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = clampFtp(value - 5);
          onChange(next);
          setDraft(String(next));
        }
      }}
      aria-label={ariaLabel}
      data-testid={dataTestId}
      className={className}
    />
  );
}

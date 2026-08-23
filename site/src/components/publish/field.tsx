import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * One labelled field.
 *
 * The label, the hint and the error are wired to the control by id rather than
 * sitting near it visually: `aria-describedby` is what makes a screen reader
 * read "the floor is 0.020000 ALGO" as part of the field instead of as loose
 * text somewhere on the page, and `aria-invalid` is what makes the failure
 * perceivable without relying on the red.
 *
 * Eight fields share this. Written out per field it is the same six lines each
 * time, and the first one to lose its `aria-describedby` would be the one
 * nobody notices.
 */
export function Field({
  label,
  hint,
  error,
  required,
  multiline,
  value,
  onChange,
  onBlur,
  placeholder,
  maxLength,
  rows = 3,
  mono,
}: {
  label: string;
  hint?: string;
  /** A sentence to show under the control. Its presence is what marks the field invalid. */
  error?: string | null;
  required?: boolean;
  multiline?: boolean;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
  /** Ids, prices and addresses are read character by character. */
  mono?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  const control = cn(
    "w-full bg-paper border rounded-xl px-4 py-3 text-sm text-ink transition-colors",
    "placeholder:text-ink/35 focus:outline-none focus:border-ink/50",
    mono && "font-mono",
    error ? "border-status-down" : "border-sand",
  );

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="text-status-down"> *</span>}
      </label>

      {hint && (
        <p id={hintId} className="text-xs text-ink/55 mt-1 leading-relaxed">
          {hint}
        </p>
      )}

      <div className="mt-2">
        {multiline ? (
          <textarea
            id={id}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            placeholder={placeholder}
            maxLength={maxLength}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            className={cn(control, "resize-y")}
          />
        ) : (
          <input
            id={id}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            placeholder={placeholder}
            maxLength={maxLength}
            required={required}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            className={control}
          />
        )}
      </div>

      {error && (
        <p id={errorId} className="text-xs text-status-down mt-2 leading-relaxed">
          {error}
        </p>
      )}
    </div>
  );
}

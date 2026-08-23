import { useState, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { Field } from "@/components/publish/field";
import {
  looksLikeAlgorandAddress,
  priceProblem,
  registerAgent,
  type RegisterInput,
  type RegistryListing,
} from "@/lib/registry";

/** The id rule the API enforces, restated so the form can catch it first. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

type FieldName = keyof RegisterInput;

/**
 * Which field an API failure belongs to.
 *
 * The API answers with a stable code and a sentence written to be shown as-is.
 * This map only decides WHERE the sentence goes — it never rewrites it, because
 * the server knows things the form does not (the address checksum, whether an
 * id is already owned) and paraphrasing that here is how the two drift apart.
 */
const ERROR_FIELD: Record<string, FieldName> = {
  invalid_id: "id",
  id_taken: "id",
  invalid_name: "name",
  invalid_address: "payoutAddress",
  invalid_price: "priceAlgo",
  price_below_floor: "priceAlgo",
};

const EMPTY: RegisterInput = {
  id: "",
  name: "",
  priceAlgo: "",
  payoutAddress: "",
  description: "",
  body: "",
  email: "",
  displayName: "",
};

type Errors = Partial<Record<FieldName, string>>;

interface Published {
  id: string;
  name: string;
  priceAlgo: string;
  payoutAddress: string;
  network: string;
  status: string;
}

/** 58 characters do not fit anywhere. Both ends are what a human checks. */
const ellipseAddress = (address: string) =>
  address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-8)}` : address;

export function PublishForm({ listing }: { listing: RegistryListing | null }) {
  const [values, setValues] = useState<RegisterInput>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  /** A failure that belongs to no single field — unreachable, or an unknown code. */
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [published, setPublished] = useState<Published | null>(null);

  const set = (field: FieldName) => (value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    // Clearing on edit rather than on submit: an error the visitor is actively
    // fixing should stop shouting as soon as they touch it.
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  /** Everything checkable without a round trip. Returns the failures found. */
  function validate(): Errors {
    const found: Errors = {};

    if (!ID_PATTERN.test(values.id.trim())) {
      found.id =
        "2–64 characters: lowercase letters, numbers and hyphens, starting with a letter or number.";
    }
    if (!values.name.trim()) {
      found.name = "Give the agent a name.";
    }

    const price = priceProblem(values.priceAlgo);
    if (price) found.priceAlgo = price;

    if (!looksLikeAlgorandAddress(values.payoutAddress)) {
      found.payoutAddress =
        "An Algorand address is 58 characters of A–Z and 2–7.";
    }

    return found;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    const found = validate();
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }

    setSending(true);
    // Optional fields are sent only when filled: an empty string is a value,
    // and "" is not the same as "the developer did not supply a description".
    const payload: RegisterInput = {
      id: values.id.trim(),
      name: values.name.trim(),
      priceAlgo: values.priceAlgo.trim(),
      payoutAddress: values.payoutAddress.trim(),
      ...(values.description?.trim() ? { description: values.description.trim() } : {}),
      ...(values.body?.trim() ? { body: values.body.trim() } : {}),
      ...(values.email?.trim() ? { email: values.email.trim() } : {}),
      ...(values.displayName?.trim() ? { displayName: values.displayName.trim() } : {}),
    };

    const result = await registerAgent(payload);
    setSending(false);

    if (!result.ok) {
      const field = ERROR_FIELD[result.error.error];
      if (field) setErrors({ [field]: result.error.message });
      else setFormError(result.error.message);
      return;
    }

    setPublished({
      id: result.data.id,
      name: result.data.name,
      priceAlgo: result.data.priceAlgo,
      payoutAddress: result.data.payoutAddress,
      network: result.data.network,
      status: result.data.status,
    });
  }

  if (published) {
    return (
      <div className="bg-paper border border-sand rounded-3xl p-8 md:p-10">
        <span className="w-10 h-10 rounded-full bg-status-live/15 flex items-center justify-center">
          <Check className="w-5 h-5 text-status-live" />
        </span>

        <h2 className="text-ink text-2xl font-normal tracking-tight mt-5">
          {published.name} is{" "}
          <em className="not-italic accent-serif text-[1.6rem]">listed</em>
        </h2>

        <dl className="mt-6 space-y-3 text-sm">
          {[
            ["Agent ID", published.id],
            ["Price per call", `${published.priceAlgo} ALGO`],
            ["Payout address", ellipseAddress(published.payoutAddress)],
            ["Network", published.network],
            ["Status", published.status],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-sand pb-3">
              <dt className="text-ink/55">{label}</dt>
              <dd className="text-ink font-medium text-right break-all">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="text-ink/60 text-sm mt-6 leading-relaxed">
          The price is shown exactly as the registry stored it — ALGO has six
          decimals, so "0.05" is kept as "0.050000". It is the same string the
          listing and every receipt will carry, which is why it is not trimmed
          back here.
        </p>

        <p className="text-ink/60 text-sm mt-4 leading-relaxed">
          Re-registering this id from the same address updates the listing.
          Anyone else registering it is refused rather than repointing your
          payouts.
        </p>

        <button
          type="button"
          onClick={() => {
            setPublished(null);
            setValues(EMPTY);
          }}
          className="mt-6 text-sm font-medium text-ink underline underline-offset-4 hover:opacity-70 transition-opacity"
        >
          Publish another agent
        </button>
      </div>
    );
  }

  const takenIds = listing?.agents.map((a) => a.id) ?? [];

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="bg-paper border border-sand rounded-3xl p-6 md:p-10 space-y-7"
    >
      <Field
        label="Agent ID"
        required
        mono
        value={values.id}
        onChange={set("id")}
        error={errors.id}
        maxLength={64}
        placeholder="invoice-filler"
        hint={
          takenIds.length > 0
            ? `Permanent — payouts key on it, and it cannot be changed later. Already taken: ${takenIds.join(", ")}.`
            : "Permanent — payouts key on it, and it cannot be changed later."
        }
      />

      <Field
        label="Name"
        required
        value={values.name}
        onChange={set("name")}
        error={errors.name}
        placeholder="Invoice Filler"
      />

      <Field
        label="Description"
        multiline
        rows={2}
        value={values.description ?? ""}
        onChange={set("description")}
        placeholder="Fills a supplier invoice from a structured payload."
        hint="One sentence. This is the line buyers read in the listing."
      />

      <Field
        label="Agent body"
        multiline
        rows={6}
        value={values.body ?? ""}
        onChange={set("body")}
        placeholder="The prompt or skill definition the agent runs."
        hint="The prompt or skill itself. Optional here — you can add it later."
      />

      <Field
        label="Price per call"
        required
        mono
        value={values.priceAlgo}
        onChange={set("priceAlgo")}
        onBlur={() => {
          const problem = priceProblem(values.priceAlgo);
          if (problem) setErrors((prev) => ({ ...prev, priceAlgo: problem }));
        }}
        error={errors.priceAlgo}
        placeholder="0.02"
        hint="A plain decimal in ALGO, at most six places. The floor is 0.020000 — below that the network fee costs more than the sale."
      />

      <Field
        label="Payout address"
        required
        mono
        value={values.payoutAddress}
        onChange={(value) => {
          set("payoutAddress")(value);
          // Checked as it is typed, but only once it is long enough to judge —
          // flagging a 4-character address is just noise while someone pastes.
          if (value.length >= 58 && !looksLikeAlgorandAddress(value)) {
            setErrors((prev) => ({
              ...prev,
              payoutAddress: "An Algorand address is 58 characters of A–Z and 2–7.",
            }));
          }
        }}
        error={errors.payoutAddress}
        maxLength={58}
        placeholder="58 characters, base32"
        hint="Where your share lands. Public the moment anyone pays you. The checksum is verified server-side, so a well-shaped address can still come back rejected."
      />

      <div className="grid sm:grid-cols-2 gap-7">
        <Field
          label="Display name"
          value={values.displayName ?? ""}
          onChange={set("displayName")}
          placeholder="Optional"
          hint="Shown as the author of the listing."
        />
        <Field
          label="Email"
          value={values.email ?? ""}
          onChange={set("email")}
          placeholder="Optional"
          hint="Only used to reach you about this listing."
        />
      </div>

      {formError && (
        <p
          role="alert"
          className="text-sm text-status-down bg-status-down/[0.08] border border-status-down/25 rounded-xl px-4 py-3"
        >
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={sending}
        className="inline-flex items-center gap-2 bg-ink text-paper text-sm font-medium uppercase tracking-wide rounded-full px-7 py-3.5 hover:bg-ink-strong disabled:opacity-60 disabled:pointer-events-none transition-colors"
      >
        {sending && <Loader2 className="w-4 h-4 animate-spin" />}
        {sending ? "Publishing" : "Publish agent"}
      </button>
    </form>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Weekday } from "@/domain/scheduling";
import type { AgencySettings } from "@/services/agency-settings";
import { saveSettingsAction } from "../actions";
import styles from "../configuracoes.module.css";

const DAYS: Array<{ id: Weekday; short: string; long: string }> = [
  { id: "mon", short: "Seg", long: "segunda" },
  { id: "tue", short: "Ter", long: "terça" },
  { id: "wed", short: "Qua", long: "quarta" },
  { id: "thu", short: "Qui", long: "quinta" },
  { id: "fri", short: "Sex", long: "sexta" },
  { id: "sat", short: "Sáb", long: "sábado" },
  { id: "sun", short: "Dom", long: "domingo" },
];

const TIMES = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

function leadLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutos antes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hora antes" : `${hours} horas antes`;
}

function Switch({ id, on, label, onChange }: { id: string; on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={on} className={styles.switchButton} data-on={on} onClick={() => onChange(!on)}>
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
      {label}: <strong>{on ? "ligado" : "desligado"}</strong>
    </button>
  );
}

type Field = keyof AgencySettings;

/**
 * The two blocks of the screen. Every change stays local until *Salvar*, which
 * says what happened; a refused value is named next to its field. A switched-off
 * block keeps its values visible, dimmed, so turning it back on is one tap.
 */
export function SettingsForm({ initial, leadChoices }: { initial: AgencySettings; leadChoices: number[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState(initial);
  const [result, setResult] = useState<{ text: string; error: boolean; field?: Field } | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function set<K extends keyof AgencySettings>(key: K, value: AgencySettings[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setResult(null);
  }

  function toggleDay(day: Weekday): void {
    set("windowDays", form.windowDays.includes(day) ? form.windowDays.filter((d) => d !== day) : [...form.windowDays, day]);
  }

  function save(): void {
    startTransition(async () => {
      const { timezone: _timezone, ...input } = form;
      const saved = await saveSettingsAction(input);
      setResult(saved.ok ? { text: "Salvo. Já vale para as próximas mensagens.", error: false } : { text: saved.message, error: true, field: saved.field });
      if (saved.ok) router.refresh();
    });
  }

  const fieldError = (field: Field) =>
    result?.error === true && result.field === field ? (
      <span role="alert" className={styles.fieldError}>
        {result.text}
      </span>
    ) : null;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <section className={styles.block} aria-labelledby="followup-title">
        <div className={styles.blockHead}>
          <h2 id="followup-title" className={styles.blockTitle}>
            Follow-up automático
          </h2>
          <p className={styles.blockHelp}>Quando um lead para de responder, a Sofia retoma a conversa — só dentro desta janela.</p>
          <Switch id="followup-enabled" on={form.followupEnabled} label="Follow-up automático" onChange={(on) => set("followupEnabled", on)} />
        </div>

        <fieldset className={styles.fields} data-off={!form.followupEnabled}>
          <legend className={styles.legend}>Dias da semana</legend>
          <div className={styles.days}>
            {DAYS.map((day) => (
              <button
                key={day.id}
                type="button"
                className={styles.day}
                aria-pressed={form.windowDays.includes(day.id)}
                aria-label={day.long}
                onClick={() => toggleDay(day.id)}
              >
                {day.short}
              </button>
            ))}
          </div>
          {fieldError("windowDays")}

          <div className={styles.times}>
            <label className={styles.label} htmlFor="window-start">
              Das
              <select id="window-start" className={styles.select} value={form.windowStart} onChange={(e) => set("windowStart", e.target.value)}>
                {TIMES.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label} htmlFor="window-end">
              às
              <select id="window-end" className={styles.select} value={form.windowEnd} onChange={(e) => set("windowEnd", e.target.value)}>
                {TIMES.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {fieldError("windowStart")}
          {fieldError("windowEnd")}
          <p className={styles.hint}>
            Fuso: {form.timezone}. Fora da janela, o follow-up espera ela abrir — ou alguém usa <em>Enviar agora</em> na fila.
          </p>
        </fieldset>
      </section>

      <section className={styles.block} aria-labelledby="reminder-title">
        <div className={styles.blockHead}>
          <h2 id="reminder-title" className={styles.blockTitle}>
            Lembrete de visita e conversa
          </h2>
          <p className={styles.blockHelp}>
            A Sofia lembra o lead do que foi marcado, a qualquer hora — mas nunca de quem pediu para não receber mensagens.
          </p>
          <Switch id="reminders-enabled" on={form.remindersEnabled} label="Lembretes" onChange={(on) => set("remindersEnabled", on)} />
        </div>

        <fieldset className={styles.fields} data-off={!form.remindersEnabled}>
          <legend className={styles.legend}>Antecedência</legend>
          <select
            id="reminder-lead"
            aria-label="Antecedência do lembrete"
            className={styles.select}
            value={form.reminderLeadMinutes}
            onChange={(e) => set("reminderLeadMinutes", Number(e.target.value))}
          >
            {leadChoices.map((minutes) => (
              <option key={minutes} value={minutes}>
                {leadLabel(minutes)}
              </option>
            ))}
          </select>
          {fieldError("reminderLeadMinutes")}
          <p className={styles.hint}>Marcado com menos antecedência do que isso, não há lembrete: o lead acabou de confirmar.</p>
        </fieldset>
      </section>

      <div className={styles.footer}>
        <button type="submit" className={styles.save} disabled={pending || !dirty}>
          {pending ? "Salvando…" : "Salvar"}
        </button>
        {result !== null && result.field === undefined && (
          <span role="status" className={result.error ? styles.messageError : styles.message}>
            {result.text}
          </span>
        )}
      </div>
    </form>
  );
}

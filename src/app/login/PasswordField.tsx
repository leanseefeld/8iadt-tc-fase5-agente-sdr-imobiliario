"use client";

import { useState } from "react";
import styles from "./login.module.css";

/**
 * The only client component on `/login`. A phone keyboard makes a password
 * typo easy to miss, so this is a visibility toggle, not a second factor —
 * `type="text"` on demand, nothing else changes. Still a plain named input
 * inside the surrounding `<form>`, so it works with JavaScript disabled: the
 * toggle is inert then, but the field itself still submits.
 */
export function PasswordField() {
  const [visible, setVisible] = useState(false);

  return (
    <div className={styles.passwordWrap}>
      <input
        id="password"
        name="password"
        type={visible ? "text" : "password"}
        required
        autoComplete="current-password"
        className={styles.passwordInput}
      />
      <button
        type="button"
        className={styles.toggleButton}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? "ocultar" : "mostrar"}
      </button>
    </div>
  );
}

import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { loginAction } from "./actions";
import { PasswordField } from "./PasswordField";
import styles from "./login.module.css";

/**
 * `/login` — Constitution X: a broker on a phone, between viewings, coming
 * back to check a lead. The one thing they came to do is get past this form
 * in one try, so the e-mail field is autofocused, there is exactly one
 * primary action, and a failure shows inline rather than as a toast that can
 * be missed.
 *
 * A Server Component with a plain `<form action={loginAction}>` — no
 * `useActionState` — so the whole flow (FR-005) works with JavaScript
 * disabled: submitting posts back to this same route, which re-renders with
 * `?erro=1` on failure or redirects to `/leads` on success.
 */

type SearchParams = Record<string, string | string[] | undefined>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await getSession();
  if (session) redirect("/leads"); // FR-007: an already-authenticated visit skips the form

  const params = await searchParams;
  const hasError = params.erro !== undefined;

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>SDR Imobiliário</h1>
        <h2 className={styles.subtitle}>Entrar</h2>

        {hasError && (
          <p className={styles.error} role="alert">
            E-mail ou senha inválidos.
          </p>
        )}

        <form className={styles.form} action={loginAction}>
          <div className={styles.field}>
            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              className={styles.textInput}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password">Senha</label>
            <PasswordField />
          </div>

          <button type="submit" className={styles.submitButton}>
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}

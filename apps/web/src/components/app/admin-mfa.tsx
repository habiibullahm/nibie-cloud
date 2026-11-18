"use client"

import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getSupabase } from "@/lib/auth/supabase"
import { TOTP_DIGITS, isCompleteTotp, normalizeTotp, sortFactors, totpQrSrc } from "@/lib/admin-mfa-rules"

type Phase =
  | { kind: "loading" }
  | { kind: "enroll"; factorId: string; qr: string | null; secret: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "failed"; message: string }

const LOAD_FAILED = "Verifikasi dua langkah belum bisa disiapkan. Muat ulang halaman, atau periksa apakah MFA (TOTP) aktif di Supabase."

/**
 * The admin panel needs a second factor (the backend answers `mfa_required` until the session is `aal2`). First visit:
 * enrol an authenticator app from a QR code. Later visits: enter the current code. Both end in `challengeAndVerify`,
 * after which Supabase holds an `aal2` session and `onVerified` reloads the panel.
 */
export function AdminMfa({ onVerified }: { onVerified: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Enrolment creates a factor; strict mode runs effects twice in development.
    if (started.current) return
    started.current = true
    void (async () => {
      const supabase = getSupabase()
      if (!supabase) return setPhase({ kind: "failed", message: LOAD_FAILED })
      const listed = await supabase.auth.mfa.listFactors()
      if (listed.error) return setPhase({ kind: "failed", message: LOAD_FAILED })
      const { verified, unfinished } = sortFactors(listed.data.all)
      if (verified) return setPhase({ kind: "challenge", factorId: verified.id })
      // An enrolment that was never confirmed is useless; clear it so a fresh QR code can be made.
      for (const f of unfinished) await supabase.auth.mfa.unenroll({ factorId: f.id })
      const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Nibie Cloud admin ${Date.now()}` })
      if (enrolled.error) return setPhase({ kind: "failed", message: LOAD_FAILED })
      setPhase({ kind: "enroll", factorId: enrolled.data.id, qr: totpQrSrc(enrolled.data.totp.qr_code), secret: enrolled.data.totp.secret })
    })()
  }, [])

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const supabase = getSupabase()
    if (!supabase || (phase.kind !== "enroll" && phase.kind !== "challenge") || !isCompleteTotp(code)) return
    setBusy(true)
    setError(null)
    const { error: e2 } = await supabase.auth.mfa.challengeAndVerify({ factorId: phase.factorId, code })
    setBusy(false)
    if (e2) {
      setCode("")
      setError("Kode salah atau sudah kedaluwarsa. Masukkan kode terbaru dari aplikasi authenticator.")
      return
    }
    onVerified()
  }

  if (phase.kind === "loading") {
    return (
      <Card>
        <CardHeader>
          <h1 className="type-h1">Verifikasi dua langkah</h1>
          <CardDescription>Menyiapkan verifikasi…</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (phase.kind === "failed") {
    return (
      <Card>
        <CardHeader>
          <h1 className="type-h1">Verifikasi dua langkah</h1>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive" role="alert">
            <AlertDescription>{phase.message}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const partial = code.length > 0 && code.length < TOTP_DIGITS
  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">Verifikasi dua langkah</h1>
        <CardDescription>
          {phase.kind === "enroll"
            ? "Panel admin memuat data semua pelanggan, jadi butuh kode dari aplikasi authenticator (misalnya Google Authenticator, 1Password atau Authy). Pindai kode QR ini sekali, lalu masukkan kode 6 angka yang muncul."
            : "Masukkan kode 6 angka dari aplikasi authenticator untuk membuka panel admin."}
        </CardDescription>
      </CardHeader>
      <form onSubmit={verify}>
        <CardContent className="grid gap-4">
          {phase.kind === "enroll" ? (
            <div className="grid gap-3">
              {phase.qr ? (
                // A data URL from Supabase: next/image adds nothing here, and an SVG inside <img> runs no script.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={phase.qr} alt="Kode QR untuk aplikasi authenticator" width={192} height={192} className="rounded-md bg-foreground p-2" />
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="mfa-secret">Tidak bisa memindai? Masukkan kunci ini secara manual</Label>
                <Input id="mfa-secret" readOnly value={phase.secret} className="font-mono" onFocus={(ev) => ev.currentTarget.select()} />
              </div>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="mfa-code">Kode authenticator</Label>
            <Input
              id="mfa-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern={`\\d{${TOTP_DIGITS}}`}
              maxLength={TOTP_DIGITS}
              value={code}
              aria-describedby="mfa-code-hint"
              onChange={(ev) => {
                setCode(normalizeTotp(ev.target.value))
                setError(null)
              }}
              className="font-mono tracking-widest"
            />
            <p id="mfa-code-hint" className={partial ? "text-foreground" : "text-muted-foreground"}>
              {partial ? `${code.length} dari ${TOTP_DIGITS} angka.` : `Kode ${TOTP_DIGITS} angka, berganti setiap 30 detik.`}
            </p>
          </div>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={busy || !isCompleteTotp(code)}>
            {busy ? "Memeriksa…" : "Verifikasi"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { useApiMode, useMe } from "@/hooks/use-hermes"
import { getSupabase } from "@/lib/auth/supabase"

export default function AccountPage() {
  const me = useMe()
  const router = useRouter()
  const customer = useApiMode() === "customer"
  const [signingOut, setSigningOut] = useState(false)

  // Same sign-out as the navigation rail (app-shell.tsx): end the Supabase session, then leave.
  const signOut = async () => {
    setSigningOut(true)
    await getSupabase()?.auth.signOut()
    router.push("/sign-in")
  }

  return (
    <div className="grid gap-8">
      <PageHeader title="Account" description="Your Nibie Cloud profile and sign-in." />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>The name and email you signed up with. They cannot be changed here yet.</CardDescription>
          {customer ? null : (
            <CardAction>
              <PreviewNote what="Account" />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="acc-name">Name</Label>
            <Input id="acc-name" value={me.data?.name ?? ""} readOnly />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="acc-email">Email</Label>
            <Input id="acc-email" type="email" value={me.data?.email ?? ""} readOnly />
          </div>
        </CardContent>
        <CardFooter className="border-t">
          <Button type="button" variant="outline" onClick={signOut} disabled={signingOut}>
            <LogOut aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}

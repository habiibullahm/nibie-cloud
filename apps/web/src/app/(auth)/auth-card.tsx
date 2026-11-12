"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/** UI shell only: customer auth is a later milestone. Submitting continues to the preview. */
export function AuthCard({ mode }: { mode: "sign-in" | "register" }) {
  const router = useRouter()
  const [terms, setTerms] = useState(false)
  const register = mode === "register"

  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">{register ? "Create account" : "Sign in"}</h1>
        <CardDescription>
          {register ? "Deploy your own Hermes agent in a few minutes." : "Welcome back. Manage your Hermes instances."}
        </CardDescription>
      </CardHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          router.push(register ? "/deploy" : "/instances")
        }}
      >
        <CardContent className="grid gap-4">
          {register ? (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" autoComplete="name" />
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" placeholder="you@example.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete={register ? "new-password" : "current-password"} />
          </div>
          {register ? (
            <div className="flex items-start gap-3">
              <Checkbox id="terms" checked={terms} onCheckedChange={(v) => setTerms(v === true)} className="mt-1" />
              <Label htmlFor="terms" className="text-muted-foreground">
                I agree to the terms of service and the data retention policy.
              </Label>
            </div>
          ) : null}
          <Alert>
            <AlertDescription>Sign-in is not live yet. Continuing opens the dashboard preview.</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="mt-4 flex-col items-stretch gap-3">
          <Button type="submit" disabled={register && !terms}>
            {register ? "Create account" : "Sign in"}
          </Button>
          <p className="text-center text-muted-foreground">
            {register ? "Already have an account? " : "New to Hermes Cloud? "}
            <Link href={register ? "/sign-in" : "/register"} className="text-foreground">
              {register ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}

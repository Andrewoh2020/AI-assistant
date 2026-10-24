import { SignIn } from "@clerk/nextjs";

/**
 * One screen for both signing in and creating an account: "Continue with Google", or an email
 * address and the code Clerk emails to it. Afterwards /signed-in starts our own session (and
 * sends new people to the welcome questions). Its look is set in app/layout.tsx.
 */
export default function SignInPage() {
  return (
    <main className="center-page">
      <SignIn
        routing="path"
        path="/sign-in"
        withSignUp
        forceRedirectUrl="/signed-in"
        signUpForceRedirectUrl="/signed-in"
      />
    </main>
  );
}

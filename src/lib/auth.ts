// NextAuth configuration — credentials provider backed by the dRamp database.
// Roles: USER | PROVIDER_OPERATOR | ADMIN
// Sign-up does NOT create an account directly; it creates a WaitlistEntry that
// an admin must approve before the user can log in.

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const ROLE = {
  USER: "USER",
  PROVIDER_OPERATOR: "PROVIDER_OPERATOR",
  ADMIN: "ADMIN",
} as const;

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // 7 days
  pages: {
    // We render auth inline on /, but keep a friendly error page.
    error: "/",
  },
  providers: [
    CredentialsProvider({
      name: "dRamp",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.password) return null;
        if (user.status !== "ACTIVE") return null;

        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          role: user.role,
          isDemo: user.isDemo,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.role = (user as any).role;
        token.isDemo = (user as any).isDemo;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).isDemo = token.isDemo;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

// Augment NextAuth types with our custom fields.
declare module "next-auth" {
  interface User {
    role?: string;
    isDemo?: boolean;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: string;
      isDemo: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: string;
    isDemo: boolean;
  }
}

// Hash a password for storage.
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

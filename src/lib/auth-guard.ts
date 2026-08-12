// Auth guards for API routes.
import { getServerSession } from "next-auth";
import { authOptions, ROLE } from "@/lib/auth";

export interface AuthedUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  isDemo: boolean;
}

export async function requireUser(): Promise<AuthedUser | { error: Response } > {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return { error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) };
  }
  const u = session.user as any;
  return { id: u.id, email: u.email, name: u.name, role: u.role, isDemo: u.isDemo };
}

export async function requireAdmin(): Promise<AuthedUser | { error: Response }> {
  const r = await requireUser();
  if ("error" in r) return r;
  if (r.role !== ROLE.ADMIN) {
    return { error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }) };
  }
  return r;
}

export async function requireOperatorOrAdmin(): Promise<AuthedUser | { error: Response }> {
  const r = await requireUser();
  if ("error" in r) return r;
  if (r.role !== ROLE.ADMIN && r.role !== ROLE.PROVIDER_OPERATOR) {
    return { error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }) };
  }
  return r;
}

export function isAuthed(r: AuthedUser | { error: Response }): r is AuthedUser {
  return !("error" in r);
}

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getPrisma } from "@/lib/db/prisma";
import { getUserByEmail, promoteFirstAdminAndMigrateLegacyFavorites } from "@/lib/db/users";
import { verifyPassword } from "@/lib/auth/password";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: {
    strategy: "jwt",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const prisma = getPrisma();
        if (!prisma) {
          console.error("[auth] 邮箱登录需要可用数据库");
          return null;
        }

        const email = credentials?.email?.toString().trim().toLowerCase();
        const password = credentials?.password?.toString();
        if (!email || !password) return null;

        const user = await getUserByEmail(email);
        if (!user?.passwordHash) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        let isAdmin = user.isAdmin;
        try {
          const result = await promoteFirstAdminAndMigrateLegacyFavorites(user.id);
          if (result.promoted) isAdmin = true;
        } catch (error) {
          console.error("[auth] 首个管理员初始化失败:", error);
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.isAdmin = Boolean((user as { isAdmin?: boolean }).isAdmin);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
        session.user.isAdmin = Boolean(token.isAdmin);
      }
      return session;
    },
  },
});

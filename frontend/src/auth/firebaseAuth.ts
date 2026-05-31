import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type Unsubscribe,
  type User
} from "firebase/auth";
import type { FirebaseClientConfig } from "../api/client";

let configuredAuth: ReturnType<typeof getAuth> | undefined;

export async function configureFirebaseAuth(config: FirebaseClientConfig): Promise<void> {
  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  configuredAuth = getAuth(app);
  await setPersistence(configuredAuth, browserLocalPersistence);
}

function getConfiguredAuth(): ReturnType<typeof getAuth> {
  if (!configuredAuth) {
    throw new Error("Firebase Auth ainda nao foi configurado.");
  }
  return configuredAuth;
}

export function subscribeFirebaseUser(callback: (user: User | null) => void): Unsubscribe {
  return onAuthStateChanged(getConfiguredAuth(), callback);
}

export async function signInWithEmailPassword(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(getConfiguredAuth(), email, password);
}

export async function signOutFirebase(): Promise<void> {
  await signOut(getConfiguredAuth());
}

export async function currentFirebaseToken(): Promise<string | undefined> {
  return getConfiguredAuth().currentUser?.getIdToken();
}

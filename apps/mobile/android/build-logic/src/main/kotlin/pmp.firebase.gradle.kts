// Firebase for an app that needs it (ADR 0037): only the parents' app, for notifications. Reads
// the module's google-services.json into resources. The file is committed: it isn't a secret,
// and its API key is restricted to the app's packages and signing certificates (ADR 0033).
plugins {
    id("com.google.gms.google-services")
}

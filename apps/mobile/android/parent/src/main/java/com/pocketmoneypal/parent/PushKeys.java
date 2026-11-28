package com.pocketmoneypal.parent;

import android.content.Context;
import android.annotation.SuppressLint;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Log;

import java.security.GeneralSecurityException;
import java.security.KeyPair;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * This phone's Web Push keys (ADR 0037): a P-256 key pair and a 16-byte auth secret, as a browser
 * keeps for each subscription. They're made in software (ECDH needs the private key on every
 * Android version from 8) and kept in the app's private storage, encrypted with an AES key that
 * never leaves Android Keystore. The app's data isn't backed up (ADR 0035), so they stay on this
 * phone.
 *
 * <p>If they can't be read back (the Keystore key was lost), new ones are made; the caller then
 * hands the server a new subscription. Written with {@code commit()}, off the main thread, so the
 * keys are on disk before the subscription leaves the phone.
 */
@SuppressLint("ApplySharedPref")
final class PushKeys {
    private static final String TAG = "PmpPush";
    private static final String PREFS = "push-keys";
    private static final String WRAP_ALIAS = "pmp-push-wrap";
    private static final String PRIVATE = "private";
    private static final String PUBLIC = "public";
    private static final String AUTH = "auth";
    private static final int GCM_IV = 12;

    final PrivateKey privateKey;
    /** {@code p256dh}: the 65-byte uncompressed public key. */
    final byte[] publicRaw;
    final byte[] auth;

    private PushKeys(PrivateKey privateKey, byte[] publicRaw, byte[] auth) {
        this.privateKey = privateKey;
        this.publicRaw = publicRaw;
        this.auth = auth;
    }

    /** The keys, or null when there are none (or they can't be read). */
    static synchronized PushKeys load(Context context) {
        SharedPreferences prefs = prefs(context);
        String priv = prefs.getString(PRIVATE, null);
        String pub = prefs.getString(PUBLIC, null);
        String auth = prefs.getString(AUTH, null);
        if (priv == null || pub == null || auth == null) return null;
        try {
            SecretKey wrap = wrapKey(false);
            if (wrap == null) return null;
            return new PushKeys(
                    WebPushCrypto.privateFromPkcs8(unwrap(wrap, priv)),
                    Base64.getDecoder().decode(pub),
                    unwrap(wrap, auth));
        } catch (GeneralSecurityException | RuntimeException e) {
            Log.w(TAG, "push keys unreadable; new ones will be made", e);
            return null;
        }
    }

    /** The keys, made now if there are none. */
    static synchronized PushKeys loadOrCreate(Context context) throws GeneralSecurityException {
        PushKeys existing = load(context);
        if (existing != null) return existing;
        KeyPair pair = WebPushCrypto.newKeyPair();
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        byte[] publicRaw = WebPushCrypto.rawPublic((ECPublicKey) pair.getPublic());
        SecretKey wrap = wrapKey(true);
        prefs(context).edit()
                .putString(PRIVATE, wrap(wrap, pair.getPrivate().getEncoded()))
                .putString(PUBLIC, Base64.getEncoder().encodeToString(publicRaw))
                .putString(AUTH, wrap(wrap, auth))
                .commit();
        return new PushKeys(pair.getPrivate(), publicRaw, auth);
    }

    /** Forgets the keys (notifications turned off, or the phone unpaired). */
    static synchronized void forget(Context context) {
        prefs(context).edit().clear().commit();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The Keystore's AES key; made when {@code create} and missing. */
    private static SecretKey wrapKey(boolean create) throws GeneralSecurityException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        try {
            store.load(null);
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
        if (store.containsAlias(WRAP_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(WRAP_ALIAS, null)).getSecretKey();
        }
        if (!create) return null;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    /** IV ‖ ciphertext, base64. Keystore picks the IV. */
    private static String wrap(SecretKey key, byte[] plain) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(plain);
        byte[] out = Arrays.copyOf(iv, iv.length + sealed.length);
        System.arraycopy(sealed, 0, out, iv.length, sealed.length);
        return Base64.getEncoder().encodeToString(out);
    }

    private static byte[] unwrap(SecretKey key, String stored) throws GeneralSecurityException {
        byte[] all = Base64.getDecoder().decode(stored);
        if (all.length <= GCM_IV) throw new GeneralSecurityException("too short");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, GCM_IV));
        return cipher.doFinal(all, GCM_IV, all.length - GCM_IV);
    }
}

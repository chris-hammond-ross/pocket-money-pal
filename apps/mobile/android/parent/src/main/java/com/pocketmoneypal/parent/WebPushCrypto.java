package com.pocketmoneypal.parent;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Web Push's message encryption, the receiving end (RFC 8291 over RFC 8188 {@code aes128gcm}),
 * as a browser does it (ADR 0036, ADR 0037). The family server encrypts each notification to
 * this phone's P-256 public key and auth secret; the push gateway forwards the bytes untouched;
 * this turns them back into the server's {@code PushMessage} JSON.
 *
 * <p>Plain Java with no Android types, so the unit tests run it on the JVM. The reference is the
 * relay repo's {@code push/test-page/index.html}, {@code decrypt()}.
 */
final class WebPushCrypto {
    private static final int SALT = 16;
    private static final int HEADER = SALT + 4 + 1;
    private static final int POINT = 65;
    private static final int TAG = 16;
    private static final byte[] KEY_INFO = ascii("WebPush: info\0");
    private static final byte[] CEK_INFO = ascii("Content-Encoding: aes128gcm\0");
    private static final byte[] NONCE_INFO = ascii("Content-Encoding: nonce\0");

    private static ECParameterSpec p256;

    private WebPushCrypto() {}

    /** A new P-256 key pair for a subscription. */
    static KeyPair newKeyPair() throws GeneralSecurityException {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    /** The public key as Web Push's {@code p256dh}: the 65-byte uncompressed point. */
    static byte[] rawPublic(ECPublicKey key) {
        byte[] raw = new byte[POINT];
        raw[0] = 0x04;
        fixed32(key.getW().getAffineX(), raw, 1);
        fixed32(key.getW().getAffineY(), raw, 33);
        return raw;
    }

    static PrivateKey privateFromPkcs8(byte[] pkcs8) throws GeneralSecurityException {
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
    }

    static PublicKey publicFromRaw(byte[] raw) throws GeneralSecurityException {
        if (raw.length != POINT || raw[0] != 0x04) throw new GeneralSecurityException("not an uncompressed P-256 point");
        BigInteger x = new BigInteger(1, Arrays.copyOfRange(raw, 1, 33));
        BigInteger y = new BigInteger(1, Arrays.copyOfRange(raw, 33, POINT));
        return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), curve()));
    }

    /** P-256's parameters, read off a generated key: every provider can make one. */
    static synchronized ECParameterSpec curve() throws GeneralSecurityException {
        if (p256 == null) p256 = ((ECPublicKey) newKeyPair().getPublic()).getParams();
        return p256;
    }

    /**
     * Decrypts one {@code aes128gcm} body (a single record: the server's messages are a few
     * hundred bytes, and the gateway refuses anything over 2,900).
     *
     * @param privateKey this phone's private key
     * @param publicRaw this phone's public key, as sent in the subscription ({@code p256dh})
     * @param auth the subscription's 16-byte auth secret
     */
    static byte[] decrypt(byte[] body, PrivateKey privateKey, byte[] publicRaw, byte[] auth)
            throws GeneralSecurityException {
        if (body.length < HEADER) throw new GeneralSecurityException("too short for a header");
        byte[] salt = Arrays.copyOfRange(body, 0, SALT);
        int recordSize = ByteBuffer.wrap(body, SALT, 4).getInt();
        int idLength = body[SALT + 4] & 0xff;
        if (idLength != POINT) throw new GeneralSecurityException("the key id isn't a P-256 key");
        int start = HEADER + idLength;
        if (body.length < start + TAG + 1) throw new GeneralSecurityException("too short for a record");
        if (recordSize < TAG + 2 || body.length - start > recordSize) {
            throw new GeneralSecurityException("more than one record");
        }
        byte[] serverRaw = Arrays.copyOfRange(body, HEADER, start);
        byte[] ciphertext = Arrays.copyOfRange(body, start, body.length);

        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(privateKey);
        agreement.doPhase(publicFromRaw(serverRaw), true);
        byte[] shared = agreement.generateSecret();

        byte[] ikm = hkdf(auth, shared, concat(KEY_INFO, publicRaw, serverRaw), 32);
        byte[] cek = hkdf(salt, ikm, CEK_INFO, 16);
        byte[] nonce = hkdf(salt, ikm, NONCE_INFO, 12);

        Cipher aes = Cipher.getInstance("AES/GCM/NoPadding");
        aes.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(TAG * 8, nonce));
        byte[] padded = aes.doFinal(ciphertext);
        // The last record ends with 0x02, then any padding zeros.
        int end = padded.length - 1;
        while (end >= 0 && padded[end] == 0) end--;
        if (end < 0 || padded[end] != 0x02) throw new GeneralSecurityException("bad padding delimiter");
        return Arrays.copyOf(padded, end);
    }

    /** HKDF-SHA256 (RFC 5869), for outputs of at most one hash (32 bytes). */
    static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int length) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info);
        mac.update((byte) 1);
        return Arrays.copyOf(mac.doFinal(), length);
    }

    private static void fixed32(BigInteger value, byte[] out, int offset) {
        byte[] bytes = value.toByteArray();
        int copy = Math.min(bytes.length, 32);
        System.arraycopy(bytes, bytes.length - copy, out, offset + 32 - copy, copy);
    }

    private static byte[] concat(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int at = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, at, part.length);
            at += part.length;
        }
        return out;
    }

    private static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }
}

package com.pocketmoneypal.parent;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPrivateKeySpec;
import java.util.Base64;
import java.util.Properties;

import org.junit.Test;

/** RFC 8291 decryption, against the RFC's own example and a message from the server's web-push. */
public class WebPushCryptoTest {
    private static byte[] b64u(String text) {
        return Base64.getUrlDecoder().decode(text);
    }

    private static PrivateKey privateFromRaw(byte[] d) throws GeneralSecurityException {
        return KeyFactory.getInstance("EC")
                .generatePrivate(new ECPrivateKeySpec(new BigInteger(1, d), WebPushCrypto.curve()));
    }

    @Test
    public void decryptsTheRfcExample() throws Exception {
        // RFC 8291, Appendix A.
        byte[] body = b64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        byte[] plain = WebPushCrypto.decrypt(body,
                privateFromRaw(b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")),
                b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
                b64u("BTBZMqHH6r4Tts7J_aSIgg"));
        assertEquals("When I grow up, I want to be a watermelon", new String(plain, StandardCharsets.UTF_8));
    }

    @Test
    public void decryptsWhatTheServerSends() throws Exception {
        Properties fixture = new Properties();
        try (InputStream in = getClass().getResourceAsStream("/web-push-message.properties")) {
            fixture.load(in);
        }
        byte[] plain = WebPushCrypto.decrypt(b64u(fixture.getProperty("body")),
                privateFromRaw(b64u(fixture.getProperty("uaPrivate"))),
                b64u(fixture.getProperty("uaPublic")),
                b64u(fixture.getProperty("auth")));
        assertArrayEquals(b64u(fixture.getProperty("plaintext")), plain);
    }

    @Test
    public void refusesAMessageForOtherKeys() throws Exception {
        Properties fixture = new Properties();
        try (InputStream in = getClass().getResourceAsStream("/web-push-message.properties")) {
            fixture.load(in);
        }
        KeyPair other = WebPushCrypto.newKeyPair();
        assertThrows(GeneralSecurityException.class, () -> WebPushCrypto.decrypt(
                b64u(fixture.getProperty("body")),
                other.getPrivate(),
                WebPushCrypto.rawPublic((ECPublicKey) other.getPublic()),
                b64u(fixture.getProperty("auth"))));
    }

    @Test
    public void refusesAShortBody() {
        assertThrows(GeneralSecurityException.class,
                () -> WebPushCrypto.decrypt(new byte[10], null, new byte[65], new byte[16]));
    }

    @Test
    public void roundTripsAPublicKey() throws Exception {
        KeyPair pair = WebPushCrypto.newKeyPair();
        byte[] raw = WebPushCrypto.rawPublic((ECPublicKey) pair.getPublic());
        assertEquals(65, raw.length);
        assertArrayEquals(raw, WebPushCrypto.rawPublic((ECPublicKey) WebPushCrypto.publicFromRaw(raw)));
    }
}

import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "../index";

describe("DefaultRedactor text stream", () => {
  const samples = [
    "before api_key=SECRET after",
    "before api_key   =SECRET after",
    'before "api_key":"SECRET" after',
    "before 'refresh_token' = 'a!b@c#d$e%f&g' after",
    "before Bearer SECRET after",
    "before Bearer\nSECRET after",
    "xapi_key=value unchanged",
    "xBearer value unchanged",
    'x"token"="SECRET" safe trailing safe trailing safe trailing safe trailing ',
    "x'refresh_token'='SECRET' safe trailing safe trailing safe trailing safe trailing ",
    "safe ordinary text tokenization without a credential",
    `token=short ${"ordinary trailing text ".repeat(5)}`,
    `Bearer short ${"ordinary trailing text ".repeat(5)}`,
    `first token=one then api_key=two and Bearer three ending safely ${".".repeat(40)}`,
  ];

  for (const sample of samples) {
    it(`matches whole-text redaction at every split: ${sample.replace("SECRET", "synthetic")}`, () => {
      const redactor = new DefaultRedactor();
      const expected = redactor.redact(sample);
      for (let split = 0; split <= sample.length; split += 1) {
        const stream = redactor.createTextStream();
        const actual = [
          stream.push(sample.slice(0, split)),
          stream.push(sample.slice(split)),
          stream.flush(),
        ].join("");
        expect(actual, `split ${split}`).toBe(expected);
      }
      const characterStream = redactor.createTextStream();
      const actual = [
        ...Array.from(sample, (character) => characterStream.push(character)),
        characterStream.flush(),
      ].join("");
      expect(actual, "character chunks").toBe(expected);
    });
  }

  it("masks a registered multiline secret at every split", () => {
    const sample = "before synthetic\nprivate fixture after";
    const redactor = new DefaultRedactor();
    redactor.registerSecret("synthetic\nprivate fixture", "test");
    const expected = redactor.redact(sample);

    for (let split = 0; split <= sample.length; split += 1) {
      const stream = redactor.createTextStream();
      const actual = [
        stream.push(sample.slice(0, split)),
        stream.push(sample.slice(split)),
        stream.flush(),
      ].join("");
      expect(actual, `split ${split}`).toBe(expected);
    }
  });

  it("does not corrupt output after a redacted secret has left the carry", () => {
    const text = `before abcd after ${"safe text ".repeat(12)}`;
    const redactor = new DefaultRedactor();
    redactor.registerSecret("abcd", "synthetic-label");
    const expected = redactor.redact(text);

    for (const chunkSize of [1, 2, 3, 7, 15, 20, 30]) {
      const stream = redactor.createTextStream();
      let actual = "";
      for (let index = 0; index < text.length; index += chunkSize) {
        actual += stream.push(text.slice(index, index + chunkSize));
      }
      actual += stream.flush();
      expect(actual, `chunks ${chunkSize}`).toBe(expected);
    }
  });
});

declare module "qrcode-terminal" {
  interface GenerateOptions {
    small?: boolean;
  }

  interface QrCodeTerminal {
    generate(text: string, options?: GenerateOptions): void;
  }

  const qrcode: QrCodeTerminal;
  export default qrcode;
}

# Web SSTV
## Summary
Web SSTV aims to both encode and decode SSTV using plain JavaScript and Web Audio API. Web SSTV can be run entirely offline (without styling), and on any platform from Chromebooks to phones, so long as they support JavaScript and Web Audio. By making SSTV readily available on many platforms, we aim to create educational opportunities and introduce more people to STEM and amateur radio. Web SSTV is currently hosted at https://ckegel.github.io/Web-SSTV/.
## Current State
Web SSTV supports both **encoding** and **decoding** of SSTV images.

**Encoding** is supported for the Martin, Scottie, PD, and WRAASE SC2-180 formats. Support for transmitting in the Robot format and in black and white is underway.

**Decoding** works from either a live microphone feed or an uploaded audio file (e.g. a WAV recording). The mode is detected automatically from the VIS header and the image is rendered line-by-line as it decodes. Decoding is implemented as a custom Web Audio Worklet using a quadrature FM discriminator (per-sample instantaneous-frequency demodulation) with per-line sync correction. The following modes are decoded:

- Martin: M1, M2
- Scottie: 1, 2, DX
- PD: PD50, PD90, PD120, PD160, PD180, PD240, PD290
- WRAASE: SC2-180

The decoder's DSP core is covered by a deterministic test suite (`node --test 'test/*.test.js'`). Pull requests are welcome.
## Sources
Both the [SSTV Handbook](https://www.sstv-handbook.com/) and [JL Barber's (N7CXI) Proposal for SSTV Mode Specifications ](http://www.barberdsp.com/downloads/Dayton%20Paper.pdf) were heavily referenced when implementing support for the Martin and Scottie formats.
## License
Web-SSTV is available freely under the MIT license. Should you decide to host your own instance of WebSSTV, you must provide a link to this repository and a copy of the MIT license, including the original copyright statement.

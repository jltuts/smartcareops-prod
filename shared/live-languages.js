// Gemini Live API documented language support for the configured
// gemini-3.8-live native-audio model. Keep this list in the frontend and
// backend allowlist together so the UI cannot submit unreviewed locale codes.
const entries = `Afrikaans|af
Akan|ak
Albanian|sq
Amharic|am
Arabic|ar
Armenian|hy
Assamese|as
Azerbaijani|az
Basque|eu
Belarusian|be
Bengali|bn
Bosnian|bs
Bulgarian|bg
Burmese|my
Catalan|ca
Cebuano|ceb
Chinese (Simplified)|zh-Hans
Chinese (Traditional)|zh-Hant
Croatian|hr
Czech|cs
Danish|da
Dutch|nl
English|en
Estonian|et
Faroese|fo
Filipino / Tagalog|fil
Finnish|fi
French|fr
Galician|gl
Georgian|ka
German|de
Greek|el
Gujarati|gu
Hausa|ha
Hebrew|he
Hindi|hi
Hungarian|hu
Icelandic|is
Indonesian|id
Irish|ga
Italian|it
Japanese|ja
Kannada|kn
Kazakh|kk
Khmer|km
Kinyarwanda|rw
Korean|ko
Kurdish|ku
Kyrgyz|ky
Lao|lo
Latvian|lv
Lithuanian|lt
Macedonian|mk
Malay|ms
Malayalam|ml
Maltese|mt
Maori|mi
Marathi|mr
Mongolian|mn
Nepali|ne
Norwegian|no
Odia|or
Oromo|om
Pashto|ps
Persian|fa
Polish|pl
Portuguese (Brazil)|pt-BR
Portuguese (Portugal)|pt-PT
Punjabi|pa
Quechua|qu
Romanian|ro
Romansh|rm
Russian|ru
Serbian|sr
Sindhi|sd
Sinhala|si
Slovak|sk
Slovenian|sl
Somali|so
Southern Sotho|st
Spanish|es
Swahili|sw
Swedish|sv
Tajik|tg
Tamil|ta
Telugu|te
Thai|th
Tswana|tn
Turkish|tr
Turkmen|tk
Ukrainian|uk
Urdu|ur
Uzbek|uz
Vietnamese|vi
Welsh|cy
Western Frisian|fy
Wolof|wo
Yoruba|yo
Zulu|zu`;

export const LIVE_SUPPORTED_LANGUAGES = Object.freeze(entries.split('\n').map(line => {
  const [label, code] = line.split('|');
  return Object.freeze({ label, code });
}));

export const DEFAULT_LIVE_LANGUAGE = 'en';
export const isSupportedLiveLanguage = value => LIVE_SUPPORTED_LANGUAGES.some(({ code }) => code === value);
export const isSupportedByLiveModel = (value, model = 'gemini-3.8-live') => model === 'gemini-3.8-live'
  ? isSupportedLiveLanguage(value)
  : value === DEFAULT_LIVE_LANGUAGE;
export const liveLanguagesForModel = (model = 'gemini-3.8-live') => Object.freeze(
  model === 'gemini-3.8-live'
    ? [...LIVE_SUPPORTED_LANGUAGES]
    : LIVE_SUPPORTED_LANGUAGES.filter(({ code }) => code === DEFAULT_LIVE_LANGUAGE),
);
export const liveLanguage = value => LIVE_SUPPORTED_LANGUAGES.find(({ code }) => code === value) || LIVE_SUPPORTED_LANGUAGES.find(({ code }) => code === DEFAULT_LIVE_LANGUAGE);

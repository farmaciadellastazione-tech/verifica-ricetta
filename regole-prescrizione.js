// regole-prescrizione.js — aggiornamenti normativi approvati (note AIFA,
// riclassificazioni, DPC). Generato da tools/update-regole.mjs e rivisto a mano
// nella PR prima del merge. Campi: tipo, farmaci, regola, dal (decorrenza),
// estratto (citazione testuale della circolare), fonte (oggetto della mail),
// d (data della mail), k (Message-ID). Per togliere una regola cancellare la
// sua riga: la circolare resta in REGOLE_ESAMINATE e non viene riproposta.
const REGOLE_PRESCRIZIONE = [
{"tipo":"riclassificazione","farmaci":["Levotuss Tosse"],"regola":"La specialità medicinale Levotuss Tosse® gocce è riclassificata dalla classe A alla classe C. Su ricetta SSN non è più rimborsabile e il costo è a carico del cittadino. Il regime di fornitura rimane invariato (RR).","dal":"31/10/2026","estratto":"riclassificazione della specialità medicinale Levotuss Tosse® 60mg/ml gocce orali, soluzione, flacone 30 ml dalla classe A in classe C","fonte":"231 -RRS- RICLASSIFICAZIONE SPECIALITA' MEDICINALE LEVOTUSS GOCCE IN CLASSE C","d":"30/10/2026","k":"<MI1P293MB0489BB96B97A267196DA2A1ED76D2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>"},
{"tipo":"nota_aifa","farmaci":["diidrocodeina","diidrocodeina associata ad acido benzoico"],"regola":"Per i farmaci a base di diidrocodeina e diidrocodeina associata ad acido benzoico, la rimborsabilità SSN tramite Nota AIFA 31 è limitata alla tosse persistente non produttiva nelle gravi pneumopatie croniche e nelle neoplasie polmonari primitive o secondarie.","dal":"31/10/2026","estratto":"nella Nota 31 rimangono i farmaci a base di diidrocodeina e diidrocodeina associata ad acido benzoico","fonte":"241 -AIFA-DETERMINAZIONI 20 OTTOBRE 2026. AGGIORNAMENTO NOTA AIFA 31.","d":"12/11/2026","k":"<MI1P293MB04890B2BBFA84DDF579B7A94D7702@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>"},
];
// Message-ID delle mail già lette (con o senza regole): non si rileggono.
const REGOLE_ESAMINATE = [
"<MI1P293MB0489C852D40B0EF25CD7F119D79B2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04899D0AF6A454EFB52BE023D7642@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB0489BB96B97A267196DA2A1ED76D2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04890803B892B2CB90EC77D3D7722@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04890B2BBFA84DDF579B7A94D7702@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04895E8B295215FD0428F3F1D77F2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04897C19D04D431586A97055D77A2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
];

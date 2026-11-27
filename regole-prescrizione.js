// regole-prescrizione.js — aggiornamenti normativi approvati (note AIFA,
// riclassificazioni, DPC). Generato da tools/update-regole.mjs e rivisto a mano
// nella PR prima del merge. Campi: tipo, farmaci, regola, dal (decorrenza),
// estratto (citazione testuale della circolare), fonte (oggetto della mail),
// d (data della mail), k (Message-ID). Per togliere una regola cancellare la
// sua riga: la circolare resta in REGOLE_ESAMINATE e non viene riproposta.
const REGOLE_PRESCRIZIONE = [
{"tipo":"riclassificazione","farmaci":["Levotuss Tosse"],"regola":"La specialità medicinale Levotuss Tosse® gocce è riclassificata dalla classe A alla classe C. Su ricetta SSN non è più rimborsabile e il costo è a carico del cittadino. Il regime di fornitura rimane invariato (RR).","dal":"31/10/2026","estratto":"riclassificazione della specialità medicinale Levotuss Tosse® 60mg/ml gocce orali, soluzione, flacone 30 ml dalla classe A in classe C","fonte":"231 -RRS- RICLASSIFICAZIONE SPECIALITA' MEDICINALE LEVOTUSS GOCCE IN CLASSE C","d":"30/10/2026","k":"<MI1P293MB0489BB96B97A267196DA2A1ED76D2@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>"},
{"tipo":"nota_aifa","farmaci":["diidrocodeina","diidrocodeina associata ad acido benzoico"],"regola":"Per i farmaci a base di diidrocodeina e diidrocodeina associata ad acido benzoico, la rimborsabilità SSN tramite Nota AIFA 31 è limitata alla tosse persistente non produttiva nelle gravi pneumopatie croniche e nelle neoplasie polmonari primitive o secondarie.","dal":"31/10/2026","estratto":"nella Nota 31 rimangono i farmaci a base di diidrocodeina e diidrocodeina associata ad acido benzoico","fonte":"241 -AIFA-DETERMINAZIONI 20 OTTOBRE 2026. AGGIORNAMENTO NOTA AIFA 31.","d":"12/11/2026","k":"<MI1P293MB04890B2BBFA84DDF579B7A94D7702@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>"},
{"tipo":"riclassificazione","farmaci":["FRISIUM"],"regola":"Il medicinale FRISIUM 10 mg 30 capsule è classificato in Classe C e non è rimborsabile dal SSN, anche se l'etichetta sul bollino riporta erroneamente la dicitura 'Confezione Dispensata Dal S.S.N.'.","dal":"28/08/2026","estratto":"Si conferma che la corretta classificazione del medicinale in oggetto è Classe C.","fonte":"184 -AIFA-NOTA INFORMATIVA RELATIVA AL MEDICINALE FRISIUM 10 MG 30 CAPSULE","d":"28/08/2026","k":"<MI1P293MB0215DE3D9044804ED9D6230AD7AC2@MI1P293MB0215.ITAP293.PROD.OUTLOOK.COM>"},
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
"<Q6W4GNR9YTU4.EIVSYZ053GS01@5b148e69db89>",
"<XOEH11JR0UU4.EOQUBQABXSI92@48b0bbffd9a2>",
"<MI1P293MB0215DE3D9044804ED9D6230AD7AC2@MI1P293MB0215.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB0215A21D51FB0D38598F1431D7BE2@MI1P293MB0215.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB04895E8AFD029067CFC5E18ED7842@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
"<MI1P293MB0489AF79D22D01DEEEA4D4C5D7832@MI1P293MB0489.ITAP293.PROD.OUTLOOK.COM>",
];

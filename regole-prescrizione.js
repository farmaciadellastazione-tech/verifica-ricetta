// regole-prescrizione.js — aggiornamenti normativi approvati (note AIFA,
// riclassificazioni, DPC). Generato da tools/update-regole.mjs e rivisto a mano
// nella PR prima del merge. Campi: tipo, farmaci, regola, dal (decorrenza),
// estratto (citazione testuale della circolare), fonte (oggetto della mail),
// d (data della mail), k (Message-ID). Per togliere una regola cancellare la
// sua riga: la circolare resta in REGOLE_ESAMINATE e non viene riproposta.
const REGOLE_PRESCRIZIONE = [
];
// Message-ID delle mail già lette (con o senza regole): non si rileggono.
const REGOLE_ESAMINATE = [
];

Métadonnées des clics
====================

Chaque ouverture d'un lien existant met à jour son document Firestore urls/{id} :
- clicks : nombre total de clics ; mobileClicks : nombre de clics mobiles.
- lastClickAt : date serveur du dernier clic ; lastClickIP : adresse IP reçue.
- userAgent et referer : en-têtes envoyés par le navigateur.
- deviceType, deviceVendor, deviceModel : type, fabricant et modèle d'appareil.
- osName, osVersion, browserName, browserVersion : système et navigateur.

Ces champs décrivent le dernier clic uniquement, comme dans la version précédente.
Les valeurs absentes sont enregistrées comme chaînes vides. Le referer est souvent
absent lors d'une ouverture depuis un SMS ou selon les réglages du navigateur.
Les informations d'appareil sont déduites du User-Agent, pas garanties.
L'IP provient du premier X-Forwarded-For, sinon de la connexion : le proxy doit
contrôler cet en-tête pour que l'adresse soit fiable.

Compteurs et métadonnées sont enregistrés dans une même écriture, attendue avant
la redirection. Cela ajoute le délai de l'écriture Firestore à l'ouverture du lien.
Si l'écriture échoue, la destination s'ouvre quand même et les logs contiennent
"Metadata update error for short link <id>" ; ce clic n'est alors pas enregistré.
Les redirections portent Cache-Control: no-store pour éviter leur mise en cache.

Après déploiement, les prochains clics renseignent ces champs sur les liens
existants et nouveaux, sans migration. Les métadonnées non enregistrées auparavant
ne peuvent pas être reconstituées. Aucun historique par clic n'est créé.

Vérification
============

npm test

Les tests utilisent le vrai parseur User-Agent et simulent Firestore, sans compte
Firebase ni connexion réseau. Ils couvrent les métadonnées mobiles/desktop,
les en-têtes absents, IPv4/IPv6, l'ordre écriture/redirection, les erreurs
d'écriture et le maintien du blocage après trois liens inexistants.

Pour vérifier après déploiement : ouvrir un lien connu puis consulter urls/{id}
dans Firestore. Vérifier l'incrément de clicks et l'actualisation de lastClickAt,
lastClickIP, userAgent et des champs appareil/navigateur.

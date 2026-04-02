const whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function startOnboarding(user) {
  const name = user.display_name?.split(' ')[0] || 'toi';
  await whatsapp.sendText(user.whatsapp_id,
    'Salut ' + name + ' !\n\nMoi c\'est Will, ton coach IA personnel.\n\nChaque matin, je t\'envoie un truc utile sur l\'IA : un outil a decouvrir, un tuto pratique ou un defi. Et tu peux me poser n\'importe quelle question a tout moment.\n\nAvant de commencer, j\'ai besoin de mieux te connaitre pour adapter mes conseils.'
  );
  await delay(1000);
  await whatsapp.sendButtons(user.whatsapp_id, 'Quel est ton niveau en IA ?', [
    { id: 'level_debutant', title: 'Debutant' },
    { id: 'level_intermediaire', title: 'Intermediaire' },
    { id: 'level_avance', title: 'Avance' },
  ]);
}

async function handleOnboardingResponse(user, buttonId) {
  if (buttonId?.startsWith('level_')) {
    const level = buttonId.replace('level_', '');
    await updateProfile(user.id, { level });
    await whatsapp.sendButtons(user.whatsapp_id, 'Top ! Et tu fais quoi dans la vie ?', [
      { id: 'job_marketing', title: 'Marketing/Comm' },
      { id: 'job_tech', title: 'Tech/Dev' },
      { id: 'job_business', title: 'Business/Finance' },
    ], null, 'Tu pourras preciser apres');
    return true;
  }
  if (buttonId?.startsWith('job_')) {
    const jobMap = { job_marketing: 'Marketing / Communication', job_tech: 'Tech / Developpement', job_business: 'Business / Finance' };
    const job = jobMap[buttonId] || buttonId.replace('job_', '');
    await updateProfile(user.id, { job, onboarding_complete: true });
    await whatsapp.sendText(user.whatsapp_id,
      'Parfait, c\'est note !\n\nTon profil :\n- Niveau : ' + (user.level || 'debutant') + '\n- Domaine : ' + job + '\n\nA partir de demain matin a 8h, tu recevras ton premier message quotidien.\n\nEn attendant, pose-moi n\'importe quelle question sur l\'IA !'
    );
    await delay(1500);
    await whatsapp.sendButtons(user.whatsapp_id, 'Pour commencer, qu\'est-ce qui t\'interesse le plus ?', [
      { id: 'topic_outils', title: 'Decouvrir des outils' },
      { id: 'topic_prompt', title: 'Ecrire de bons prompts' },
      { id: 'topic_actu', title: 'Actu IA du moment' },
    ]);
    return true;
  }
  return false;
}

module.exports = { startOnboarding, handleOnboardingResponse };

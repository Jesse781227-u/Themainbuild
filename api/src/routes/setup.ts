import {Router} from 'express';
import {z} from 'zod';
import {requireRole, requireTenant} from '../middleware/auth';
import {adminDb} from '../services/firebase-admin';
import {AppError} from '../lib/errors';

const sectionIds = ['basic','contact','branding','location','inventory','fulfillment'] as const;
const sectionStatus = z.enum(['not_started','in_progress','completed','skipped']);
const progressPatch = z.object({
  sections: z.record(z.enum(sectionIds), sectionStatus).optional(),
  lastPromptedAt: z.string().datetime().optional(),
  reminderScheduledFor: z.string().datetime().optional(),
}).strict();
const profilePatch=z.object({name:z.string().min(2).max(120).optional(),category:z.string().optional(),description:z.string().optional(),logo:z.string().optional(),banner:z.string().optional(),address:z.string().optional(),serviceArea:z.string().optional(),whatsapp:z.string().optional(),website:z.string().optional(),fulfillment:z.array(z.string()).optional()}).strict();

export const setup = Router();

setup.put('/:businessId/profile', requireTenant, requireRole('owner','admin'), async (req,res,next)=>{try{const parsed=profilePatch.parse(req.body);await adminDb.collection('businesses').doc(req.businessId!).set({...parsed,updatedAt:new Date().toISOString()}, {merge:true});return res.json({success:true,data:{businessId:req.businessId,...parsed}})}catch(error){return next(new AppError('VALIDATION_ERROR',error instanceof Error?error.message:'Invalid business profile'))}});

setup.get('/:businessId/setup-progress', requireTenant, async (req, res, next) => {
  try {
    const snapshot = await adminDb.collection('setupProgress').doc(req.businessId!).get();
    if (!snapshot.exists) return res.json({success:true, data:{businessId:req.businessId, rewardGranted:true, sections:Object.fromEntries(sectionIds.map(id=>[id,'not_started']))}});
    return res.json({success:true, data:{businessId:req.businessId, ...snapshot.data()}});
  } catch (error) { return next(error); }
});

setup.patch('/:businessId/setup-progress', requireTenant, requireRole('owner','admin'), async (req, res, next) => {
  try {
    const parsed = progressPatch.safeParse(req.body);
    if (!parsed.success) return next(new AppError('VALIDATION_ERROR','Only setup statuses and reminder timestamps may be saved.'));
    const ref = adminDb.collection('setupProgress').doc(req.businessId!);
    const current = (await ref.get()).data() || {rewardGranted:true, sections:Object.fromEntries(sectionIds.map(id=>[id,'not_started']))};
    const currentSections = current.sections as Record<string, string>;
    const sections = {...currentSections};
    for (const id of sectionIds) {
      const nextStatus = parsed.data.sections?.[id];
      const previous = currentSections[id] || 'not_started';
      if (nextStatus && previous !== 'completed' && previous !== 'skipped') sections[id] = nextStatus;
    }
    const updated = {rewardGranted:Boolean(current.rewardGranted ?? true), sections, ...(parsed.data.lastPromptedAt ? {lastPromptedAt:parsed.data.lastPromptedAt}:{}), ...(parsed.data.reminderScheduledFor ? {reminderScheduledFor:parsed.data.reminderScheduledFor}:{})};
    await ref.set(updated, {merge:true});
    await adminDb.collection('businesses').doc(req.businessId!).collection('auditLogs').add({action:'setup_progress_updated',actorId:req.userId,createdAt:new Date().toISOString(),changedSections:Object.keys(parsed.data.sections || {})});
    return res.json({success:true,data:{businessId:req.businessId,...updated}});
  } catch (error) { return next(error); }
});

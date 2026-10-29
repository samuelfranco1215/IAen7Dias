-- =========================================================
-- IA en 7 Días - Esquema oficial para Supabase (PostgreSQL)
-- Se ejecuta automáticamente si está definido POSTGRES_URL / DATABASE_URL,
-- o puedes pegarlo una sola vez en el SQL Editor de Supabase.
-- =========================================================

-- 1. Tabla principal de estado de la plataforma (alumnos, configuración y lecciones)
CREATE TABLE IF NOT EXISTS public.ia7d_state (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabla estructurada de alumnos (sincronizada en cada guardado para consultas en Supabase Table Editor)
CREATE TABLE IF NOT EXISTS public.ia7d_students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  doc_type TEXT,
  doc_number TEXT,
  whatsapp TEXT,
  payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
  access_code TEXT,
  progress_percentage INTEGER NOT NULL DEFAULT 0,
  completed_lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
  certificate_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  certificate_code TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ia7d_students_email ON public.ia7d_students (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_ia7d_students_status ON public.ia7d_students (payment_status);

-- 3. Tabla de archivos privados (comprobantes Nequi y evidencias de lecciones)
-- Sirve como respaldo inmediato si el bucket de Supabase Storage no está creado.
CREATE TABLE IF NOT EXISTS public.ia7d_uploads (
  pathname TEXT PRIMARY KEY,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  content_base64 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permisos para el rol service_role y acceso desde la API de Supabase
ALTER TABLE public.ia7d_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ia7d_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ia7d_uploads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ia7d_state' AND policyname = 'ia7d_state_service_all'
  ) THEN
    CREATE POLICY ia7d_state_service_all ON public.ia7d_state FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ia7d_students' AND policyname = 'ia7d_students_service_all'
  ) THEN
    CREATE POLICY ia7d_students_service_all ON public.ia7d_students FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ia7d_uploads' AND policyname = 'ia7d_uploads_service_all'
  ) THEN
    CREATE POLICY ia7d_uploads_service_all ON public.ia7d_uploads FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;


/**
 * Generador de Certificados en PDF para "IA en 7 Días"
 * Utiliza jsPDF para crear un documento vectorial nítido, elegante y descargable al instante.
 */

window.CertificateGenerator = {
  _logoDataUrl: null,

  _preloadLogo: function() {
    if (this._logoDataUrl) return Promise.resolve(this._logoDataUrl);
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || 586;
          canvas.height = img.naturalHeight || 520;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          this._logoDataUrl = canvas.toDataURL('image/png');
          resolve(this._logoDataUrl);
        } catch (e) {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = 'images/logo-crop.png';
    });
  },

  /**
   * Genera y descarga el certificado en formato PDF
   * @param {Object} student - Objeto alumno con name, certificateCode, certificateIssuedAt
   */
  downloadPDF: async function(student) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert("Cargando la librería de generación de PDF. Por favor intenta de nuevo en unos segundos.");
      return;
    }

    const logoData = await this._preloadLogo();

    const { jsPDF } = window.jspdf;
    // Formato horizontal A4 (297mm ancho x 210mm alto)
    const doc = new jsPDF({
      orientation: 'landscape',
      unit: 'mm',
      format: 'a4'
    });

    const studentName = student.name || 'Estudiante Destacado';
    const certCode = student.certificateCode || ('IA7D-2026-' + Math.random().toString(36).substring(2, 8).toUpperCase());
    
    // Formatear fecha en español
    const issueDate = student.certificateIssuedAt ? new Date(student.certificateIssuedAt) : new Date();
    const formattedDate = issueDate.toLocaleDateString('es-CO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const width = 297;
    const height = 210;

    // 1. Fondo suave crema / marfil
    doc.setFillColor(252, 252, 254);
    doc.rect(0, 0, width, height, 'F');

    // 2. Marco exterior Azul Marino Profundo (#0f172a)
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(4);
    doc.rect(10, 10, width - 20, height - 20);

    // 3. Marco interior Dorado (#d97706)
    doc.setDrawColor(217, 119, 6);
    doc.setLineWidth(1);
    doc.rect(14, 14, width - 28, height - 28);

    // 4. Detalles en las 4 esquinas (adornos dorados)
    const cornerSize = 12;
    doc.setDrawColor(180, 83, 9);
    doc.setLineWidth(1.5);
    // Superior izquierda
    doc.line(16, 16 + cornerSize, 16, 16);
    doc.line(16, 16, 16 + cornerSize, 16);
    // Superior derecha
    doc.line(width - 16 - cornerSize, 16, width - 16, 16);
    doc.line(width - 16, 16, width - 16, 16 + cornerSize);
    // Inferior izquierda
    doc.line(16, height - 16 - cornerSize, 16, height - 16);
    doc.line(16, height - 16, 16 + cornerSize, height - 16);
    // Inferior derecha
    doc.line(width - 16 - cornerSize, height - 16, width - 16, height - 16);
    doc.line(width - 16, height - 16 - cornerSize, width - 16, height - 16);

    // 5. Logo Oficial y Encabezado de la Academia
    if (logoData) {
      try {
        // Proporción original del logo recortado: 586 x 520 (~1.127:1)
        doc.addImage(logoData, 'PNG', 26, 20, 27, 24);
      } catch (e) {
        console.warn("No se pudo incrustar logo en PDF:", e);
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    doc.text("ACADEMIA DIGITAL DE INTELIGENCIA ARTIFICIAL", width / 2, 32, { align: 'center' });

    // 6. Título Principal
    doc.setFont("times", "bold");
    doc.setFontSize(28);
    doc.setTextColor(15, 23, 42);
    doc.text("CERTIFICADO DE FINALIZACIÓN", width / 2, 46, { align: 'center' });

    // Línea divisoria elegante dorada
    doc.setDrawColor(217, 119, 6);
    doc.setLineWidth(0.8);
    doc.line((width / 2) - 45, 51, (width / 2) + 45, 51);

    // 7. Texto introductorio
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    doc.setTextColor(71, 85, 105);
    doc.text("Se hace constar con orgullo que", width / 2, 62, { align: 'center' });

    // 8. Nombre del Alumno (Destacado)
    doc.setFont("times", "bolditalic");
    doc.setFontSize(26);
    doc.setTextColor(30, 58, 138); // Azul Real
    doc.text(studentName, width / 2, 78, { align: 'center' });

    // Subrayado sutil para el nombre
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.5);
    const nameWidth = doc.getTextWidth(studentName);
    doc.line((width / 2) - (nameWidth / 2) - 10, 81, (width / 2) + (nameWidth / 2) + 10, 81);

    // 9. Texto de acreditación
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(51, 65, 85);
    doc.text(
      "ha completado satisfactoriamente el programa de entrenamiento práctico intensivo:",
      width / 2,
      92,
      { align: 'center' }
    );

    // 10. Nombre del Curso (Grande)
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.setTextColor(15, 23, 42);
    doc.text("IA EN 7 DÍAS", width / 2, 106, { align: 'center' });

    // 11. Descripción de competencias
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(100, 116, 139);
    const descriptionText =
      "Demostrando dominio en prompting avanzado (R-C-T-F-R), optimización con ChatGPT y Claude, " +
      "creación de contenidos persuasivos, análisis de documentos, generación de imágenes con IA, " +
      "interpretación de datos y configuración de asistentes personalizados. Intensidad estimada: 15 horas prácticas.";
    
    const splitDesc = doc.splitTextToSize(descriptionText, 210);
    doc.text(splitDesc, width / 2, 118, { align: 'center' });

    // 12. Sello Dorado Central / Medalla
    const sealX = width / 2;
    const sealY = 152;
    
    // Círculo exterior dorado
    doc.setFillColor(245, 158, 11);
    doc.circle(sealX, sealY, 12, 'F');
    
    // Círculo concéntrico más oscuro
    doc.setDrawColor(180, 83, 9);
    doc.setLineWidth(0.6);
    doc.circle(sealX, sealY, 10);

    // Estrella o texto en el sello
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    doc.text("100% EXCELENCIA", sealX, sealY - 1, { align: 'center' });
    doc.setFontSize(6.5);
    doc.text("COMPLETADO", sealX, sealY + 2.5, { align: 'center' });

    // 13. Firmas y Fechas
    // Bloque Izquierdo: Fecha y Código de Verificación
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(51, 65, 85);
    doc.text("Fecha de Emisión:", 45, 156);
    doc.setFont("helvetica", "normal");
    doc.text(formattedDate, 45, 162);

    doc.setFont("helvetica", "bold");
    doc.text("Código de Autenticidad:", 45, 170);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 58, 138);
    doc.text(certCode, 45, 176);

    // Bloque Derecho: Firma del Instructor
    const sigLineX = width - 85;
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(0.8);
    doc.line(sigLineX, 164, sigLineX + 50, 164);

    doc.setFont("times", "italic");
    doc.setFontSize(14);
    doc.setTextColor(15, 23, 42);
    doc.text("Equipo Académico", sigLineX + 25, 160, { align: 'center' });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text("DIRECTOR ACADÉMICO", sigLineX + 25, 170, { align: 'center' });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("IA en 7 Días • Colombia", sigLineX + 25, 175, { align: 'center' });

    // 14. Pie de página legal / Aclaración de constancia no formal
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.text(
      "Constancia de aprobación emitida por IA en 7 Días conforme a programas de educación continua y desarrollo de habilidades prácticas. No requiere convalidación ministerial.",
      width / 2,
      194,
      { align: 'center' }
    );

    // Guardar y descargar
    const cleanFilename = `Certificado-IA-7-Dias-${studentName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    doc.save(cleanFilename);
  }
};

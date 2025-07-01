// Importar las dependencias necesarias.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  createClient,
  type PostgrestError as _PostgrestError,
} from "https://esm.sh/@supabase/supabase-js@2";

// Este console.log aparecerá en los logs de la Edge Function cuando se inicie.
console.log('Edge Function "register-new-user" started!');

// Contraseña genérica para el usuario que se creará en Supabase Auth.
// ¡IMPORTANTE! Para un entorno de producción, considera generar una contraseña aleatoria
// o un flujo de "restablecimiento de contraseña" para el primer login del usuario.
const GENERIC_PASSWORD = "Password123!"; // ¡CAMBIA ESTO POR UNA CONTRASEÑA MÁS SEGURA EN PRODUCCIÓN!

// Interfaz para la estructura del cuerpo de la petición que esperamos del frontend.
interface RegisterUserPayload {
  fullName: string;
  email: string;
  roleName: string;
  statusName: string;
  accessZoneNames: string[];
  faceEmbedding: number[]; // El array de 128 números flotantes
  profilePictureUrl?: string; // Opcional, si se envía la URL de la imagen
}

// Define un umbral de similitud para la detección de rostros duplicados.
// Un valor más bajo significa que los embeddings deben ser MUY similares para ser considerados duplicados.
// Este valor debe ser ajustado y probado con tus propios datos.
// Los embeddings de face-api.js suelen usar L2 (Euclidean) distance, donde 0 es idéntico.
const VECTOR_SIMILARITY_THRESHOLD = 0.5; // Ejemplo: Si la distancia es menor a 0.5, se considera un duplicado.

// La función 'serve' de Deno espera una función asíncrona que maneje las peticiones HTTP.
serve(async (req: Request) => {
  // --- Configuración de CORS ---
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*", // Permite peticiones desde cualquier origen (ajustar en producción)
        "Access-Control-Allow-Methods": "POST, OPTIONS", // Métodos permitidos
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, x-requested-with,  x-request-id",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Asegúrate de que la petición sea POST.
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method Not Allowed" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Inicialización del Cliente Supabase.
  // Usamos SUPABASE_SERVICE_ROLE_KEY para tener permisos elevados
  // y poder insertar en todas las tablas sin restricciones de RLS por ahora.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    {
      auth: { persistSession: false },
    },
  );

  let payload: RegisterUserPayload;
  try {
    payload = await req.json();
    // Validar que los campos esenciales estén presentes en el payload.
    if (
      !payload.fullName || !payload.email || !payload.roleName ||
      !payload.statusName || !payload.accessZoneNames || !payload.faceEmbedding
    ) {
      throw new Error("Missing required fields in request body.");
    }
    if (
      !Array.isArray(payload.faceEmbedding) ||
      payload.faceEmbedding.length !== 128
    ) {
      throw new Error("faceEmbedding must be an array of 128 numbers.");
    }
  } catch (error: unknown) { // Añade ': unknown' para ser explícito.
    // Manejo de errores de parsing o de campos faltantes.
    // Ahora necesitas verificar el tipo de 'error' antes de acceder a 'error.message'.
    let errorMessage = "Invalid request body";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    console.error("Error parsing request body or missing fields:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }), // Usa la variable errorMessage
      {
        status: 400, // Bad Request
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  let authUserId: string | undefined;

  try {
    // --- NUEVA VALIDACIÓN: Verificar si el embedding facial ya existe ---
    console.log("Checking for duplicate facial embeddings...");

    // Refactoricemos la consulta para que devuelva la distancia directamente y filtre.
    const { data: similarFaces, error: preciseFacesSearchError } =
      await supabase.rpc("match_face_embedding", {
        query_embedding: payload.faceEmbedding,
        match_threshold: VECTOR_SIMILARITY_THRESHOLD,
        match_count: 1, // Solo necesitamos saber si hay al menos una coincidencia
      });

    if (preciseFacesSearchError) {
      console.error(
        "Error calling match_face_embedding RPC:",
        preciseFacesSearchError,
      );
      throw new Error(
        `Failed to check for duplicate face: ${preciseFacesSearchError.message}`,
      );
    }

    if (similarFaces && similarFaces.length > 0) {
      // Si similarFaces tiene resultados, significa que ya hay un embedding dentro del umbral.
      console.warn(
        `Duplicate facial embedding detected for user ID: ${
          similarFaces[0].user_id
        }. Distance: ${similarFaces[0].distance}`,
      );
      return new Response(
        JSON.stringify({
          error:
            "A user with a very similar facial profile already exists. Please contact support if you believe this is an error.",
        }),
        {
          status: 409, // Conflict
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    console.log(
      "No duplicate facial embedding found (or distance above threshold). Proceeding with registration.",
    );

    // --- FIN DE LA VALIDACIÓN DE EMBEDDING DUPLICADO ---

    // 1. Crear usuario en la tabla privada de Supabase Auth (auth.users).
    // Se envía solo el email y la contraseña. Los metadatos adicionales
    // (full_name, role_name, status_name) se guardarán en la tabla pública 'users'.
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: payload.email,
      password: GENERIC_PASSWORD,
      options: {
        data: {
          // full_name, role_name, status_name NO se guardan aquí para mantener auth.users más limpio.
          // Estos datos se guardarán en la tabla pública 'users'.
        },
      },
    });

    if (authError) {
      console.error("Supabase Auth signUp error:", authError);
      if (authError.message.includes("User already registered")) {
        return new Response(
          JSON.stringify({
            error: "User with this email is already registered.",
          }),
          {
            status: 409, // Conflict
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      throw new Error(
        `Authentication user creation failed: ${authError.message}`,
      );
    }

    if (!authData.user) {
      // Esto es un caso raro si signUp fue exitoso pero no retornó user.
      // Puede ocurrir si se requiere confirmación por email y no hay auto-confirmación.
      throw new Error(
        "Authentication user data not returned after signup. User might need email confirmation.",
      );
    }
    authUserId = authData.user.id;
    console.log(`Auth user created with ID: ${authUserId}`);

    // 2. Obtener UUIDs de los catálogos.
    // Utilizaremos consultas directas a las tablas de catálogo.
    const { data: roleData, error: roleError } = await supabase
      .from("roles_catalog")
      .select("id")
      .eq("name", payload.roleName)
      .single();

    if (roleError || !roleData) {
      console.error("Error fetching role ID:", roleError);
      throw new Error(`Role "${payload.roleName}" not found in catalog.`);
    }
    const roleId = roleData.id;

    const { data: statusData, error: statusError } = await supabase
      .from("user_statuses_catalog")
      .select("id")
      .eq("name", payload.statusName)
      .single();

    if (statusError || !statusData) {
      console.error("Error fetching status ID:", statusError);
      throw new Error(
        `User status "${payload.statusName}" not found in catalog.`,
      );
    }
    const statusId = statusData.id;

    const { data: zonesData, error: zonesError } = await supabase
      .from("zones")
      .select("id, name") // También necesitamos el nombre para verificar si todos se encontraron
      .in("name", payload.accessZoneNames);

    if (zonesError) {
      console.error("Error fetching zone IDs:", zonesError);
      throw new Error(`Error fetching access zone IDs: ${zonesError.message}`);
    }
    if (!zonesData || zonesData.length !== payload.accessZoneNames.length) {
      const foundZoneNames = (zonesData || []).map((z) => z.name);
      const missingZones = payload.accessZoneNames.filter((name) =>
        !foundZoneNames.includes(name)
      );
      throw new Error(
        `Some access zones not found: ${
          missingZones.join(", ")
        }. Please ensure they exist in the 'zones' table.`,
      );
    }
    const resolvedZoneIds = zonesData.map((zone) => zone.id);
    console.log("Resolved IDs:", { roleId, statusId, resolvedZoneIds });

    // 3. Guardar en la tabla pública de usuarios ('users').
    // Esta tabla debe tener una FK a auth.users.id
    const currentTimestamp = new Date().toISOString(); // Captura el timestamp una vez

    const { error: publicUserError } = await supabase.from("users").insert([
      {
        id: authUserId, // Usar el UUID del usuario de autenticación
        full_name: payload.fullName,
        role_id: roleId, // El UUID del rol
        status_id: statusId, // El UUID del estado
        access_method: "facial", // Siempre "facial" en minúscula
        created_at: currentTimestamp, // Fecha de creación
        updated_at: currentTimestamp, // Fecha de actualización (igual a la creación inicialmente)
        profile_picture_url: payload.profilePictureUrl, // URL de la imagen si se envió
      },
    ]);

    if (publicUserError) {
      console.error("Public user data save failed:", publicUserError);
      throw new Error(
        `Public user data save failed: ${publicUserError.message}`,
      );
    }
    console.log("Public user data saved.");

    // 4. Guardar los accesos por zona en la tabla 'user_zone_access'.
    const zoneAccessesToInsert = resolvedZoneIds.map((zoneId) => ({
      user_id: authUserId, // UUID del usuario
      zone_id: zoneId, // UUID de la zona
    }));

    const { error: zoneAccessError } = await supabase.from("user_zone_access")
      .insert(zoneAccessesToInsert);

    if (zoneAccessError) {
      console.error("User zone access save failed:", zoneAccessError);
      throw new Error(
        `User zone access save failed: ${zoneAccessError.message}`,
      );
    }
    console.log("User zone accesses saved.");

    // 5. Guardar el embedding facial en la tabla 'faces'.
    const { error: faceEmbeddingError } = await supabase.from("faces").insert([
      {
        user_id: authUserId, // UUID del usuario
        embedding: payload.faceEmbedding, // El vector de 128 dimensiones (ya es un array de numbers)
        created_at: new Date().toISOString(), // Fecha de creación del embedding
      },
    ]);

    if (faceEmbeddingError) {
      console.error("Facial embedding save failed:", faceEmbeddingError);
      throw new Error(
        `Facial embedding save failed: ${faceEmbeddingError.message}`,
      );
    }
    console.log("Facial embedding saved.");

    // Si todo es exitoso, devolver una respuesta de éxito.
    return new Response(
      JSON.stringify({
        message: "User registered successfully!",
        userId: authUserId,
      }),
      {
        status: 200, // OK
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (catchError: unknown) {
    // Manejo centralizado de errores.
    let errorMessage = "An unexpected error occurred during user registration.";
    if (catchError instanceof Error) {
      errorMessage = catchError.message;
    } else if (typeof catchError === "string") {
      errorMessage = catchError;
    }

    // Si falló alguna inserción después de crear el usuario de autenticación,
    // podrías querer borrar ese usuario también para evitar "huérfanos".
    // Esta es una consideración avanzada para transacciones robustas.
    if (authUserId) {
      console.warn(
        `Attempting to delete partially created auth user ${authUserId} due to subsequent error.`,
      );
      const { error: deleteUserError } = await supabase.auth.admin.deleteUser(
        authUserId,
      );
      if (deleteUserError) {
        console.error(
          `Failed to delete partially created auth user ${authUserId}:`,
          deleteUserError,
        );
      }
    }

    console.error(
      "Unhandled error in register-new-user Edge Function:",
      catchError,
    );
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500, // Internal Server Error
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
